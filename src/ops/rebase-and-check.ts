import type Database from 'better-sqlite3'
import type { ForgeAdapter } from '../forge/types.js'
import type { Config, RepoConfig } from '../config/schema.js'
import { autoRebase, type RebaseConflictAnalysis, type RebaseTarget } from './rebase.js'
import type { UpdateStrategy } from '../git/worktree.js'
import { runVerifyCommands, allVerifyPassed } from '../loop/verifier.js'
import { buildVerifierEnv } from '../workers/env.js'
import type { VerifyResult } from '../workers/types.js'
import { RunManager } from '../state/runs.js'
import { AttemptChainLimitError, createFollowupAttempt } from '../state/attempts.js'
import { recordUserAction } from '../state/run-log-events.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { upsertBotComment, markerTag } from '../forge/bot-comment.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { logger } from '../utils/logger.js'
import { CostTracker } from '../loop/cost.js'
import type { MetricsService } from '../metrics/service.js'
import { createConflictResolver } from './conflict-resolver.js'
import type { ConflictResolutionMetadata } from './conflict-types.js'

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
  options: {
    check?: boolean
    strategyOverride?: UpdateStrategy
    actor?: string
    maxAttemptChainLength?: number
    triggeredBy?: { kind: 'merge-fanout'; sourcePr: number }
  } = {},
): Promise<{ queued: boolean; reason: string }> {
  const runManager = new RunManager(db)

  // Find the latest run with a branch for this issue
  const run = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (!run || !run.branchName) {
    return { queued: false, reason: 'No run with branch found for this issue' }
  }

  if (run.status === 'running' || run.status === 'queued') {
    return { queued: false, reason: `Run is already ${run.status}` }
  }

  const issueRepo = resolveIssueRepo(run.phaseData, repoConfig.repo)

  // Finalize the previous attempt and INSERT a new one that preserves the
  // branch/PR context (resetBranch=false). Prior implementation mutated
  // the same row back to queued, which conflated history with live state.
  const existingPhaseData = run.phaseData ?? {}
  try {
    createFollowupAttempt(db, {
      previousAttemptId: run.id,
      intent: 'rebase',
      resetBranch: false,
      ...(options.maxAttemptChainLength !== undefined
        ? { maxSequenceNumber: options.maxAttemptChainLength }
        : {}),
      phaseData: {
        ...existingPhaseData,
        issueRepo,
        reactionContext:
          'Rebase requested. Rebase onto latest base branch, run verify, and fix any issues introduced by upstream changes.',
        reactionType: 'rebase',
        reactionSummary: 'Rebase and re-evaluate',
      },
      controlPayload: {
        issueRepo,
        checkAfter: options.check ?? true,
        requestedAt: new Date().toISOString(),
        preserveBranchState: true,
        ...(options.strategyOverride ? { updateStrategy: options.strategyOverride } : {}),
      },
    })
  } catch (err) {
    if (err instanceof AttemptChainLimitError) {
      if (options.triggeredBy?.kind === 'merge-fanout') {
        await commentStatus(
          forge,
          issueRepo,
          issueNumber,
          botUser,
          `Skipped automatic rebase after #${options.triggeredBy.sourcePr} merged because the attempt chain limit is exhausted. Run /orch rebase or /orch retry when ready to continue manually.`,
        )
      }
      return { queued: false, reason: 'chain_exhausted' }
    }
    logger.warn({ runId: run.id, err }, 'Failed to queue rebase attempt')
    return { queued: false, reason: 'Run state changed while queuing rebase' }
  }

  const queuedRun = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (queuedRun) {
    recordUserAction(db, {
      runId: queuedRun.id,
      kind: 'rebase',
      actor: options.actor ?? 'manual',
      details: options.strategyOverride ? { strategy: options.strategyOverride } : null,
    })
  }

  // Transition labels
  try {
    const issue = await forge.getIssue(issueRepo, issueNumber)
    const fromState = run.status === 'review_ready' ? 'review_ready' : run.status === 'blocked' ? 'blocked' : 'error'
    await transitionLabels(
      forge, issueRepo, issueNumber, issue.labels,
      fromState, 'queued', buildLabelConfig(repoConfig, issue.labels),
      undefined,
      'rebase',
    )
  } catch (err) {
    logger.warn({ repo: issueRepo, issueNumber, err }, 'Failed to transition labels for rebase queue')
  }

  // Post status comment
  const queuedMessage = options.triggeredBy?.kind === 'merge-fanout'
    ? `Queued for automatic rebase and re-evaluation because #${options.triggeredBy.sourcePr} merged into the base branch. The branch will be rebased onto the latest base, verified, and if anything breaks the coder will fix it.`
    : 'Queued for rebase and re-evaluation. The branch will be rebased onto the latest base, verified, and if anything breaks the coder will fix it.'
  await commentStatus(forge, issueRepo, issueNumber, botUser, queuedMessage)

  logger.info({ repo: issueRepo, issueNumber, runId: run.id }, 'Queued issue for rebase-and-re-evaluate')
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
  verifyCommands: Array<string | string[] | { command: string | string[]; timeoutSeconds: number }>,
  checkAfter = true,
  strategy: UpdateStrategy = 'rebase',
  options: {
    issueTitle?: string
    issueBody?: string
    config?: Config
    db?: Database.Database
    runId?: string
    metrics?: MetricsService
  } = {},
): Promise<{
  rebased: boolean
  verifyPassed: boolean
  verifyResults?: VerifyResult[]
  conflict: boolean
  conflictAnalysis?: RebaseConflictAnalysis
  resolution?: ConflictResolutionMetadata
  error?: string
}> {
  const target: RebaseTarget = {
    repo,
    issueNumber,
    prNumber: 0,
    branchName,
    baseBranch,
    worktreePath,
  }

  const resolverEnabled = Boolean(
    options.config
      && options.db
      && options.issueTitle
      && typeof options.issueBody === 'string'
      && options.config.autoResolveConflicts.enabled
      && options.config.ai.internal.features.conflictResolver,
  )
  const resolver = resolverEnabled
    ? createConflictResolver({
        config: options.config!,
        costTracker: new CostTracker(options.db!),
        runId: options.runId,
      })
    : null

  const rebaseResult = await autoRebase(target, repoLocalPath, strategy, {
    resolver: resolver ?? undefined,
    context: resolver && options.issueTitle
      ? {
          issueTitle: options.issueTitle,
          issueBody: options.issueBody ?? '',
        }
      : undefined,
    metrics: options.metrics,
  })

  if (rebaseResult.result === 'up_to_date') {
    return { rebased: false, verifyPassed: true, verifyResults: [], conflict: false, resolution: rebaseResult.resolution }
  }

  if (rebaseResult.result === 'conflict') {
    return {
      rebased: false,
      verifyPassed: false,
      verifyResults: [],
      conflict: true,
      conflictAnalysis: rebaseResult.conflictAnalysis,
      resolution: rebaseResult.resolution,
    }
  }

  if (rebaseResult.result === 'error') {
    return {
      rebased: false,
      verifyPassed: false,
      verifyResults: [],
      conflict: false,
      resolution: rebaseResult.resolution,
      error: rebaseResult.error,
    }
  }

  // Rebased successfully — run verify
  if (!checkAfter || verifyCommands.length === 0) {
    return { rebased: true, verifyPassed: true, verifyResults: [], conflict: false, resolution: rebaseResult.resolution }
  }

  const verifyResults = await runVerifyCommands(worktreePath, verifyCommands, buildVerifierEnv())
  return {
    rebased: true,
    verifyPassed: allVerifyPassed(verifyResults),
    verifyResults,
    conflict: false,
    resolution: rebaseResult.resolution,
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
