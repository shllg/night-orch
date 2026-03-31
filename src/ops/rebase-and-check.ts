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

export interface RebaseAndCheckResult {
  rebaseResult: 'up_to_date' | 'rebased' | 'conflict' | 'error'
  verifyPassed: boolean | null  // null = verify not run (no rebase needed or rebase failed)
  requeued: boolean
}

/**
 * Rebase a PR's branch onto the latest base, then run verify commands
 * to check if code adjustments are needed. If verify fails, re-queue
 * the issue so the coder can fix it.
 */
export async function rebaseAndCheck(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  issueNumber: number,
  botUser: string,
  checkAfter: boolean,
): Promise<RebaseAndCheckResult> {
  const runManager = new RunManager(db)
  const labelConfig = buildLabelConfig(repoConfig)

  // Find the latest run with a branch for this issue
  const run = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (!run || !run.branchName || !run.worktreePath) {
    logger.warn({ repo: repoConfig.repo, issueNumber }, 'No run with branch found for rebase')
    return { rebaseResult: 'error', verifyPassed: null, requeued: false }
  }

  const target: RebaseTarget = {
    repo: repoConfig.repo,
    issueNumber,
    prNumber: run.prNumber ?? 0,
    branchName: run.branchName,
    baseBranch: repoConfig.baseBranch,
    worktreePath: run.worktreePath,
  }

  // Step 1: Rebase
  const rebaseResult = await autoRebase(target, repoConfig.localPath)

  if (rebaseResult === 'up_to_date') {
    logger.info({ repo: repoConfig.repo, issueNumber }, 'Branch already up to date — no rebase needed')
    await commentStatus(forge, repoConfig.repo, issueNumber, botUser,
      'Branch is already up to date with base — no rebase needed.')
    return { rebaseResult, verifyPassed: null, requeued: false }
  }

  if (rebaseResult === 'conflict') {
    logger.warn({ repo: repoConfig.repo, issueNumber }, 'Rebase had conflicts — re-queuing for coder')
    await commentStatus(forge, repoConfig.repo, issueNumber, botUser,
      'Rebase onto latest base branch resulted in conflicts. Re-queuing for the coder to resolve.')
    await requeueForFix(db, forge, repoConfig, issueNumber, run, labelConfig, 'Rebase conflict — coder needs to resolve merge conflicts with the latest base branch.')
    return { rebaseResult, verifyPassed: null, requeued: true }
  }

  if (rebaseResult === 'error') {
    logger.error({ repo: repoConfig.repo, issueNumber }, 'Rebase failed')
    await commentStatus(forge, repoConfig.repo, issueNumber, botUser,
      'Rebase failed due to an unexpected error. Check the logs.')
    return { rebaseResult, verifyPassed: null, requeued: false }
  }

  // Step 2: Rebased successfully — run verify if checkAfter is enabled
  if (!checkAfter) {
    await commentStatus(forge, repoConfig.repo, issueNumber, botUser,
      'Rebased successfully onto latest base branch.')
    return { rebaseResult, verifyPassed: null, requeued: false }
  }

  if (repoConfig.verify.length === 0) {
    await commentStatus(forge, repoConfig.repo, issueNumber, botUser,
      'Rebased successfully. No verify commands configured — skipping post-rebase check.')
    return { rebaseResult, verifyPassed: null, requeued: false }
  }

  logger.info({ repo: repoConfig.repo, issueNumber }, 'Rebase succeeded — running verify commands')
  const verifyResults = await runVerifyCommands(
    run.worktreePath,
    repoConfig.verify,
    buildVerifierEnv(),
  )
  const passed = allVerifyPassed(verifyResults)

  if (passed) {
    await commentStatus(forge, repoConfig.repo, issueNumber, botUser,
      'Rebased and all verify commands pass. No code adjustments needed.')
    return { rebaseResult, verifyPassed: true, requeued: false }
  }

  // Verify failed after rebase — re-queue for coder to fix
  const failedCommands = verifyResults
    .filter((r) => !r.passed)
    .map((r) => `\`${r.command}\` (exit ${r.exitCode})`)
    .join(', ')

  logger.warn({ repo: repoConfig.repo, issueNumber, failedCommands }, 'Verify failed after rebase — re-queuing')
  await commentStatus(forge, repoConfig.repo, issueNumber, botUser,
    `Rebased onto latest base, but verify commands failed: ${failedCommands}. Re-queuing for the coder to fix.`)
  await requeueForFix(db, forge, repoConfig, issueNumber, run, labelConfig,
    `Post-rebase verify failed: ${failedCommands}. Fix the issues introduced by the rebase.`)

  return { rebaseResult, verifyPassed: false, requeued: true }
}

async function requeueForFix(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  issueNumber: number,
  run: { id: string; status: string },
  labelConfig: ReturnType<typeof buildLabelConfig>,
  context: string,
): Promise<void> {
  const runManager = new RunManager(db)

  // Store the rebase context so the coder knows what happened
  const existingPhaseData = runManager.getById(run.id)?.phaseData ?? {}
  runManager.update(run.id, {
    status: 'queued',
    lastError: null,
    endedAt: null,
    phaseData: {
      ...existingPhaseData,
      reactionContext: context,
      reactionType: 'rebase_check',
      reactionSummary: 'Post-rebase verify failure',
    },
  })

  try {
    const issue = await forge.getIssue(repoConfig.repo, issueNumber)
    await transitionLabels(
      forge, repoConfig.repo, issue.number, issue.labels,
      'review_ready', 'queued', labelConfig,
    )
  } catch (err) {
    logger.warn({ repo: repoConfig.repo, err }, 'Failed to transition labels for rebase-and-check requeue')
  }
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
