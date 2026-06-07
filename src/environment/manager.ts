import type { RepoConfig } from '../config/schema.js'
import { logger } from '../utils/logger.js'
import { allocatePort } from './port.js'
import { runRunHooks, type RunHookCommand } from './hooks.js'
import { defaultProjectName, type RunTokens } from './tokens.js'

export interface EnvSetupResult {
  tokens: RunTokens
}

/**
 * Allocate the per-run environment tokens (`{issue}`/`{run}`/`{port}`/
 * `{project}`) without running any subprocess.
 *
 * Pure resource allocation so the caller can record the result (and reach
 * teardown in its `finally`) BEFORE the `beforeRun` hooks run — if a hook then
 * throws, `afterRun` still runs.
 */
export function prepareEnvironment(params: {
  repo: string
  issueNumber: number
  runId: string
  repoConfig: RepoConfig
  usedPorts: number[]
}): EnvSetupResult {
  const { repo, issueNumber, runId, repoConfig, usedPorts } = params
  const env = repoConfig.environment

  let port: number | undefined
  if (env?.ports) {
    port = allocatePort(env.ports, usedPorts)
    usedPorts.push(port)
  }

  const tokens: RunTokens = {
    issue: issueNumber,
    run: runId.replace(/^run-/i, '').toLowerCase(),
    port,
    project: defaultProjectName(repo, issueNumber, runId),
  }

  return { tokens }
}

/** Run the repo's `beforeRun` hooks (fail-fast) with token substitution. */
export async function runBeforeRunHooks(params: {
  worktreePath: string
  repoConfig: RepoConfig
  tokens: RunTokens
}): Promise<void> {
  const hooks = (params.repoConfig.environment?.beforeRun ?? []) as RunHookCommand[]
  if (hooks.length === 0) return
  await runRunHooks(params.worktreePath, hooks, params.tokens, 'fail-fast')
}

/**
 * Run the repo's `afterRun` hooks (attempt-all, never throws). Called from the
 * caller's `finally` so teardown happens on success, block, error, or
 * exception — and even when `beforeRun` failed.
 */
export async function teardownEnvironment(params: {
  worktreePath: string
  repoConfig: RepoConfig
  tokens: RunTokens
}): Promise<void> {
  const hooks = (params.repoConfig.environment?.afterRun ?? []) as RunHookCommand[]
  if (hooks.length === 0) return
  await runRunHooks(params.worktreePath, hooks, params.tokens, 'attempt-all')
  logger.info({ project: params.tokens.project }, 'Environment torn down')
}
