import type Database from 'better-sqlite3'
import type { ForgeAdapter } from '../forge/types.js'
import type { Config, RepoConfig } from '../config/schema.js'
import { runGit } from '../git/process.js'
import { MergeBatchManager } from './batch.js'
import { findMergeEligiblePRs } from './eligibility.js'
import { buildStagingBranch } from './staging.js'
import { finalizeMerge } from './finalize.js'
import { bisectBatch, isCulpritIdentified } from './bisect.js'
import { logger } from '../utils/logger.js'
import type { MergeBatchRecord } from './types.js'
import { RunManager } from '../state/runs.js'
import { nowUtcIso } from '../utils/time.js'
import { fanoutRebaseAfterMerge, type FanoutDeps, type FanoutResult } from '../ops/fanout-rebase.js'

/**
 * Batches left in `building` longer than this are considered stuck and
 * reset to `failed` on the next cycle. A crash between `buildStagingBranch`
 * kickoff and its completion would otherwise leave the queue wedged
 * forever, because `building` is non-terminal but `handleActiveBatch` skips
 * it by design.
 */
const STUCK_BUILDING_MS = 30 * 60 * 1000

/**
 * Process the merge queue for a single repo.
 * Called once per poll cycle, after reaction scanning.
 *
 * Flow:
 * 1. Check for active batch → if testing, check CI status
 * 2. If no active batch → scan for eligible PRs, form new batch
 */
export async function processMergeQueue(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  options: {
    config?: Config
    botUser?: string
    fanoutAfterMerge?: (deps: FanoutDeps) => Promise<FanoutResult>
  } = {},
): Promise<void> {
  if (!repoConfig.mergeQueue.enabled) return

  const batchManager = new MergeBatchManager(db)
  const activeBatch = batchManager.getActiveBatch(repoConfig.repo)

  if (activeBatch) {
    await handleActiveBatch(db, forge, repoConfig, batchManager, activeBatch, options)
  } else {
    await formNewBatch(db, forge, repoConfig, batchManager)
  }
}

async function handleActiveBatch(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  batchManager: MergeBatchManager,
  batch: MergeBatchRecord,
  options: {
    config?: Config
    botUser?: string
    fanoutAfterMerge?: (deps: FanoutDeps) => Promise<FanoutResult>
  },
): Promise<void> {
  if (batch.status === 'pending') {
    return
  }

  if (batch.status === 'building') {
    // Building is set synchronously before buildStagingBranch runs. If a
    // previous cycle crashed mid-build we would otherwise deadlock here —
    // detect stuck-building by age and fail the batch so a new one can form.
    if (isBatchStuckBuilding(batch)) {
      logger.warn(
        { repo: repoConfig.repo, batchId: batch.id, updatedAt: batch.updatedAt },
        'Merge batch stuck in building — marking failed for retry',
      )
      batchManager.update(batch.id, { status: 'failed' })
    }
    return
  }

  if (batch.status === 'testing') {
    // Check CI on the staging branch
    if (!batch.stagingSha || !forge.getRefCheckStatus) {
      logger.warn({ repo: repoConfig.repo, batchId: batch.id }, 'Cannot check staging CI — missing SHA or forge method')
      return
    }

    const ciStatus = await forge.getRefCheckStatus(repoConfig.repo, batch.stagingSha)

    if (ciStatus.overall === 'success') {
      // Finalize merge FIRST, then mark the batch passed. If finalizeMerge
      // throws, the batch stays in 'testing' so the next cycle can retry
      // rather than burying a half-completed merge in a terminal state.
      // Only close the PRs that actually made it into staging —
      // `merged_pr_numbers` was captured at staging time and excludes
      // conflict-ejected PRs.
      const mergedPrNumbers = batch.mergedPrNumbers ?? batch.prNumbers
      logger.info(
        { repo: repoConfig.repo, batchId: batch.id, prs: mergedPrNumbers },
        'Merge batch CI passed — finalizing',
      )

      try {
        await finalizeMerge(
          forge,
          repoConfig.repo,
          repoConfig.baseBranch,
          batch.stagingSha,
          mergedPrNumbers,
          batch.stagingBranch ?? '',
          repoConfig.localPath,
        )
      } catch (err) {
        logger.error(
          { repo: repoConfig.repo, batchId: batch.id, err },
          'Merge batch finalize failed — marking batch failed for bisect/quarantine',
        )
        batchManager.update(batch.id, { status: 'failed' })
        return
      }

      batchManager.update(batch.id, { status: 'passed' })
      await transitionMergedRuns(db, forge, repoConfig, mergedPrNumbers, options)
    } else if (ciStatus.overall === 'failure') {
      logger.warn({ repo: repoConfig.repo, batchId: batch.id }, 'Merge batch CI failed — bisecting')
      batchManager.update(batch.id, { status: 'failed' })

      // Retry once if configured
      if (repoConfig.mergeQueue.retryFlakyOnce && batch.retryCount === 0) {
        batchManager.update(batch.id, { status: 'testing', retryCount: 1 })
        logger.info({ repo: repoConfig.repo, batchId: batch.id }, 'Retrying batch once for flaky CI')
        return
      }

      // Bisect
      if (isCulpritIdentified(batch.prNumbers)) {
        // Single PR failed — it's the culprit
        const culprit = batch.prNumbers[0]!
        logger.warn({ repo: repoConfig.repo, prNumber: culprit }, 'Merge culprit identified')
        await quarantineCulpritPR(db, forge, repoConfig, culprit)
      } else {
        const [left, right] = bisectBatch(batch.prNumbers)
        const mid = left.length
        const leftShas = batch.approvedShas.slice(0, mid)
        const rightShas = batch.approvedShas.slice(mid)

        // Create two sub-batches
        for (const [prs, shas] of [[left, leftShas], [right, rightShas]] as [number[], string[]][]) {
          const subBatch = batchManager.create({
            repo: repoConfig.repo,
            baseBranch: repoConfig.baseBranch,
            baseSha: batch.baseSha,
            prNumbers: prs,
            approvedShas: shas,
          })
          batchManager.update(subBatch.id, { parentBatchId: batch.id, status: 'building' })

          // Build staging for sub-batch. Wrap in try/catch so a crash in
          // staging does not leave the sub-batch wedged in 'building'.
          try {
            const staging = await buildStagingBranch(
              repoConfig.localPath,
              repoConfig.baseBranch,
              prs,
              forge,
              repoConfig.repo,
              repoConfig.mergeQueue.stagingBranchPrefix,
            )
            batchManager.update(subBatch.id, {
              status: 'testing',
              stagingBranch: staging.stagingBranch,
              stagingSha: staging.stagingSha,
              mergedPrNumbers: staging.merged,
            })
          } catch (err) {
            logger.error(
              { repo: repoConfig.repo, subBatchId: subBatch.id, err },
              'Staging build threw for bisect sub-batch — marking failed',
            )
            batchManager.update(subBatch.id, { status: 'failed' })
          }
        }
      }
    }
    // If pending — CI still running, wait for next cycle
  }
}

function isBatchStuckBuilding(batch: MergeBatchRecord): boolean {
  if (batch.status !== 'building') return false
  const updatedAtMs = Date.parse(batch.updatedAt)
  if (Number.isNaN(updatedAtMs)) return false
  return Date.now() - updatedAtMs > STUCK_BUILDING_MS
}

/**
 * Transition runs associated with successfully merged PRs out of
 * `review_ready` and into `completed`. Without this, successful merges
 * leave their runs stuck in `review_ready` forever — only the failure
 * path (`quarantineCulpritPR`) previously updated run state.
 */
async function transitionMergedRuns(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  mergedPrNumbers: number[],
  options: {
    config?: Config
    botUser?: string
    fanoutAfterMerge?: (deps: FanoutDeps) => Promise<FanoutResult>
  },
): Promise<void> {
  if (mergedPrNumbers.length === 0) return
  const repo = repoConfig.repo
  const placeholders = mergedPrNumbers.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT id, pr_number
       FROM runs
       WHERE repo = ?
         AND pr_number IN (${placeholders})
         AND status = 'review_ready'`,
    )
    .all(repo, ...mergedPrNumbers) as Array<{ id: string; pr_number: number }>
  if (rows.length === 0) return

  const runManager = new RunManager(db)
  const endedAt = nowUtcIso()
  const fanout = options.fanoutAfterMerge ?? fanoutRebaseAfterMerge
  for (const row of rows) {
    try {
      runManager.updateLifecycle(row.id, { status: 'completed', lastError: null, endedAt })
      logger.info(
        { repo, runId: row.id, prNumber: row.pr_number },
        'Transitioned run out of review_ready after successful merge',
      )
      if (options.config) {
        await fanout({
          db,
          repoConfig,
          forge,
          config: options.config,
          sourcePrNumber: row.pr_number,
          baseBranch: repoConfig.baseBranch,
          botUser: options.botUser ?? '',
        })
      }
    } catch (err) {
      logger.warn(
        { repo, runId: row.id, prNumber: row.pr_number, err },
        'Failed to transition run to completed after merge',
      )
    }
  }
}

async function formNewBatch(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  batchManager: MergeBatchManager,
): Promise<void> {
  const candidates = await findMergeEligiblePRs(db, forge, repoConfig)
  if (candidates.length === 0) return

  // Take up to batchSize candidates
  const batchCandidates = candidates.slice(0, repoConfig.mergeQueue.batchSize)
  const prNumbers = batchCandidates.map(c => c.prNumber)
  const approvedShas = batchCandidates.map(c => c.headSha)

  logger.info({ repo: repoConfig.repo, prNumbers }, 'Forming new merge batch')

  // Get current base SHA
  const baseResult = await runGit(['rev-parse', `origin/${repoConfig.baseBranch}`], { cwd: repoConfig.localPath })
  const baseSha = baseResult.stdout.trim()

  // Create batch record
  const batch = batchManager.create({
    repo: repoConfig.repo,
    baseBranch: repoConfig.baseBranch,
    baseSha,
    prNumbers,
    approvedShas,
  })

  batchManager.update(batch.id, { status: 'building' })

  // Build staging branch. Wrap in try/catch so a crash here does not wedge
  // the batch in 'building' (handleActiveBatch will also recover stuck
  // builds by age as a belt-and-braces fallback).
  let staging: Awaited<ReturnType<typeof buildStagingBranch>>
  try {
    staging = await buildStagingBranch(
      repoConfig.localPath,
      repoConfig.baseBranch,
      prNumbers,
      forge,
      repoConfig.repo,
      repoConfig.mergeQueue.stagingBranchPrefix,
    )
  } catch (err) {
    logger.error(
      { repo: repoConfig.repo, batchId: batch.id, err },
      'Staging build threw — marking batch failed',
    )
    batchManager.update(batch.id, { status: 'failed' })
    return
  }

  batchManager.update(batch.id, {
    status: 'testing',
    stagingBranch: staging.stagingBranch,
    stagingSha: staging.stagingSha,
    mergedPrNumbers: staging.merged,
  })

  if (staging.ejected.length > 0) {
    logger.warn({ repo: repoConfig.repo, ejected: staging.ejected }, 'Some PRs ejected from batch due to conflicts')
  }

  logger.info({ repo: repoConfig.repo, batchId: batch.id, merged: staging.merged.length, testing: true }, 'Merge batch staged and pushed')
}

async function quarantineCulpritPR(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  prNumber: number,
): Promise<void> {
  try {
    await forge.addLabels(repoConfig.repo, prNumber, [repoConfig.labels.mergeFailed])
  } catch (err) {
    logger.warn({ repo: repoConfig.repo, prNumber, err }, 'Failed to add merge-failed label to culprit PR')
  }

  try {
    await forge.removeLabels(
      repoConfig.repo,
      prNumber,
      [repoConfig.labels.mergeQueued, repoConfig.labels.merging],
    )
  } catch (err) {
    logger.warn({ repo: repoConfig.repo, prNumber, err }, 'Failed to clear merge queue labels from culprit PR')
  }

  const rows = db
    .prepare(
      `SELECT id
       FROM runs
       WHERE repo = ?
         AND pr_number = ?
         AND status = 'review_ready'`,
    )
    .all(repoConfig.repo, prNumber) as Array<{ id: string }>
  if (rows.length === 0) return

  const runManager = new RunManager(db)
  const endedAt = nowUtcIso()
  for (const row of rows) {
    runManager.updateLifecycle(row.id, {
      status: 'blocked',
      blockReason: 'merge_conflict',
      endedAt,
    })
  }
}
