import type { Config, RepoConfig } from '../config/schema.js'
import type { WorktreeManager } from '../git/worktree.js'
import type { CommandSpec } from '../utils/command.js'
import { resolveVerifyCommands } from './verification-profile.js'
import { runVerifyCommands } from './verifier.js'
import { logger } from '../utils/logger.js'

type VerifyCommandSpec = RepoConfig['verify'][number]

export interface PreflightResult {
  /** True when the gate passed OR was disabled/not applicable. */
  ok: boolean
  /** Set only when `ok === false` — human-readable drift reason. */
  reason: string | null
  /** First failing command label, for logging/notifications. */
  failedCommand: string | null
}

export interface RunPreflightDriftCheckParams {
  config: Config
  repoConfig: RepoConfig
  worktreeManager: WorktreeManager
  worktreeRoot: string
  /** Env passed to verify commands; defaults to the current process env. */
  env?: Record<string, string>
}

/**
 * Preflight drift gate: verify the repo's base branch HEAD is green
 * before any fresh issue is dispatched in this cycle. A red base means
 * drift unrelated to queued work — dispatching onto it makes every issue
 * fail in series and can inject unrelated stale-base reverts into diffs
 * (observed in production). When this returns `ok: false`, the caller
 * should skip dispatch for the repo this cycle and surface the reason.
 *
 * Disabled by default (`repos[].preflight.enabled`). Runs in a dedicated,
 * hard-reset base worktree so it never touches in-flight issue branches.
 */
export async function runPreflightDriftCheck(
  params: RunPreflightDriftCheckParams,
): Promise<PreflightResult> {
  const { config, repoConfig, worktreeManager, worktreeRoot, env } = params

  if (!repoConfig.preflight.enabled) {
    return { ok: true, reason: null, failedCommand: null }
  }

  const commands = resolvePreflightCommands(config, repoConfig)
  if (commands.length === 0) {
    // Nothing to check against — treat as pass but warn so the operator
    // notices a misconfigured gate rather than silently trusting a red base.
    logger.warn(
      { repo: repoConfig.repo },
      'Preflight drift gate enabled but no commands resolved (no preflight.commands, stage, or verify[]) — skipping gate',
    )
    return { ok: true, reason: null, failedCommand: null }
  }

  // Dedicated base worktree, always hard-reset to base HEAD so the gate
  // reflects the true upstream state, never leftover work.
  const branchName = `${repoConfig.branchPrefix}-preflight`
  const worktreePath = `${worktreeRoot}/${repoConfig.repo.replace('/', '__')}/__preflight`
  const worktree = await worktreeManager.ensure({
    repoLocalPath: repoConfig.localPath,
    baseBranch: repoConfig.baseBranch,
    branchName,
    worktreePath,
    resetToBase: true,
    updateStrategy: repoConfig.updateStrategy,
  })

  try {
    const results = await runVerifyCommands(worktree.path, commands, env)
    const firstFailure = results.find((r) => !r.passed)
    if (firstFailure) {
      const tail = (firstFailure.stderr || firstFailure.stdout || '').slice(-400).trim()
      const reason =
        `Base branch '${repoConfig.baseBranch}' is failing preflight before any issue runs: ` +
        `\`${firstFailure.command}\` exited ${firstFailure.exitCode}.` +
        (tail ? `\n${tail}` : '')
      logger.warn(
        { repo: repoConfig.repo, baseBranch: repoConfig.baseBranch, command: firstFailure.command },
        'Preflight drift gate failed — skipping fresh dispatch for this cycle',
      )
      return { ok: false, reason, failedCommand: firstFailure.command }
    }
    return { ok: true, reason: null, failedCommand: null }
  } finally {
    // Drop the throwaway base worktree + branch so it doesn't linger.
    try {
      await worktreeManager.remove(worktree.path, true)
    } catch (err) {
      logger.debug({ repo: repoConfig.repo, err }, 'Failed to remove preflight worktree (non-fatal)')
    }
  }
}

/**
 * Resolve the commands the gate runs, in priority order:
 *  1. `preflight.commands` (explicit)
 *  2. the `preflight.stage` of the repo's verificationProfile
 *  3. the repo's `verify[]` commands
 * Only `block`/`iterate` (non-`warn`) required commands gate the batch.
 */
function resolvePreflightCommands(config: Config, repoConfig: RepoConfig): VerifyCommandSpec[] {
  const explicit = repoConfig.preflight.commands
  if (explicit && explicit.length > 0) {
    return explicit
  }

  const resolved = resolveVerifyCommands(config, repoConfig, {
    type: 'verify',
    id: 'preflight',
    profile: repoConfig.verificationProfile,
    stage: repoConfig.preflight.stage,
  })

  return resolved
    .filter((entry) => entry.required && entry.onFailure !== 'warn')
    .map((entry) => entry.command)
}

export type { CommandSpec }
