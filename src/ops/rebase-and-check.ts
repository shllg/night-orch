import type Database from 'better-sqlite3'
import type { ForgeAdapter } from '../forge/types.js'
import type { RepoConfig } from '../config/schema.js'
import { autoRebase, type RebaseTarget } from './rebase.js'
import { runVerifyCommands, allVerifyPassed } from '../loop/verifier.js'
import { buildVerifierEnv } from '../workers/env.js'
import { RunManager } from '../state/runs.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { upsertBotComment, markerTag } from '../forge/bot-comment.js'
import { logger } from '../utils/logger.js'

const STATUS_MARKER = markerTag('status')

/**
 * Queue an issue for rebase-and-re-evaluate.
 *
 * This does NOT perform the rebase inline. It transitions the run
 * to 'queued' with runMode='rebase' so the poller picks it up on
 * the next cycle. The poller will:
 * 1. Rebase the branch onto latest base
 * 2. Run verify commands
 * 3. If verify fails, run a full code→verify→review cycle to fix
 *
 * This is the right approach when PRs conceptually conflict —
 * a git rebase might succeed but the code could be semantically broken.
 */
export async function queueRebase(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  issueNumber: number,
  botUser: string,
): Promise<{ queued: boolean; reason: string }> {
  const runManager = new RunManager(db)
  const labelConfig = buildLabelConfig(repoConfig)

  // Find the latest run with a branch for this issue
  const run = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (!run || !run.branchName) {
    return { queued: false, reason: 'No run with branch found for this issue' }
  }

  if (run.status === 'running' || run.status === 'queued') {
    return { queued: false, reason: `Run is already ${run.status}` }
  }

  // Store rebase context and transition to queued
  const existingPhaseData = run.phaseData ?? {}
  runManager.update(run.id, {
    status: 'queued',
    lastError: null,
    endedAt: null,
    phaseData: {
      ...existingPhaseData,
      reactionContext: 'Rebase requested. Rebase onto latest base branch, run verify, and fix any issues introduced by upstream changes.',
      reactionType: 'rebase',
      reactionSummary: 'Rebase and re-evaluate',
    },
  })

  // Update run_mode in DB directly since RunManager.update doesn't support it yet
  db.prepare("UPDATE runs SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(run.id)

  // Transition labels
  try {
    const issue = await forge.getIssue(repoConfig.repo, issueNumber)
    const fromState = run.status === 'review_ready' ? 'review_ready' : run.status === 'blocked' ? 'blocked' : 'error'
    await transitionLabels(
      forge, repoConfig.repo, issueNumber, issue.labels,
      fromState, 'queued', labelConfig,
    )
  } catch (err) {
    logger.warn({ repo: repoConfig.repo, issueNumber, err }, 'Failed to transition labels for rebase queue')
  }

  // Post status comment
  await commentStatus(forge, repoConfig.repo, issueNumber, botUser,
    'Queued for rebase and re-evaluation. The branch will be rebased onto the latest base, verified, and if anything breaks the coder will fix it.')

  logger.info({ repo: repoConfig.repo, issueNumber, runId: run.id }, 'Queued issue for rebase-and-re-evaluate')
  return { queued: true, reason: 'Queued for rebase and re-evaluation on next poll cycle' }
}

/**
 * Execute the rebase portion of a rebase run.
 * Called by the poller when processing a queued run with rebase context.
 *
 * Returns true if the branch is clean after rebase (verify passes).
 * Returns false if verify fails — the caller should continue with
 * a code→verify→review cycle to fix the issues.
 */
export async function executeRebase(
  repoLocalPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string,
  repo: string,
  issueNumber: number,
  verifyCommands: Array<string | string[]>,
): Promise<{ rebased: boolean; verifyPassed: boolean; conflict: boolean }> {
  const target: RebaseTarget = {
    repo,
    issueNumber,
    prNumber: 0,
    branchName,
    baseBranch,
    worktreePath,
  }

  const rebaseResult = await autoRebase(target, repoLocalPath)

  if (rebaseResult === 'up_to_date') {
    return { rebased: false, verifyPassed: true, conflict: false }
  }

  if (rebaseResult === 'conflict') {
    return { rebased: false, verifyPassed: false, conflict: true }
  }

  if (rebaseResult === 'error') {
    return { rebased: false, verifyPassed: false, conflict: false }
  }

  // Rebased successfully — run verify
  if (verifyCommands.length === 0) {
    return { rebased: true, verifyPassed: true, conflict: false }
  }

  const verifyResults = await runVerifyCommands(worktreePath, verifyCommands, buildVerifierEnv())
  return { rebased: true, verifyPassed: allVerifyPassed(verifyResults), conflict: false }
}

async function commentStatus(
  forge: ForgeAdapter,
  repo: string,
  issueNumber: number,
  botUser: string,
  message: string,
): Promise<void> {
  try {
    if (botUser) {
      await upsertBotComment(forge, repo, issueNumber, STATUS_MARKER, `**night-orch**: ${message}`, botUser)
    } else {
      await forge.commentOnIssue(repo, issueNumber, `**night-orch**: ${message}`)
    }
  } catch (err) {
    logger.warn({ repo, issueNumber, err }, 'Failed to post rebase status comment')
  }
}
