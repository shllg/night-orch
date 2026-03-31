import { execa } from 'execa'
import type Database from 'better-sqlite3'
import type { ForgeAdapter } from '../forge/types.js'
import type { RepoConfig } from '../config/schema.js'
import { MergeBatchManager } from './batch.js'
import { findMergeEligiblePRs } from './eligibility.js'
import { buildStagingBranch } from './staging.js'
import { finalizeMerge } from './finalize.js'
import { bisectBatch, isCulpritIdentified } from './bisect.js'
import { logger } from '../utils/logger.js'
import type { MergeBatchRecord } from './types.js'

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
): Promise<void> {
  if (!repoConfig.mergeQueue.enabled) return

  const batchManager = new MergeBatchManager(db)
  const activeBatch = batchManager.getActiveBatch(repoConfig.repo)

  if (activeBatch) {
    await handleActiveBatch(db, forge, repoConfig, batchManager, activeBatch)
  } else {
    await formNewBatch(db, forge, repoConfig, batchManager)
  }
}

async function handleActiveBatch(
  _db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  batchManager: MergeBatchManager,
  batch: MergeBatchRecord,
): Promise<void> {
  if (batch.status === 'pending' || batch.status === 'building') {
    // Batch is being built — skip this cycle
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
      // Batch passed — finalize merge
      logger.info({ repo: repoConfig.repo, batchId: batch.id, prs: batch.prNumbers }, 'Merge batch CI passed — finalizing')
      batchManager.update(batch.id, { status: 'passed' })

      await finalizeMerge(
        forge,
        repoConfig.repo,
        repoConfig.baseBranch,
        batch.stagingSha,
        batch.prNumbers,
        batch.stagingBranch ?? '',
        repoConfig.localPath,
      )
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
        // TODO: label the culprit PR, remove from queue
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
          batchManager.update(subBatch.id, { parentBatchId: batch.id })

          // Build staging for sub-batch
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
          })
        }
      }
    }
    // If pending — CI still running, wait for next cycle
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
  const baseResult = await execa('git', ['rev-parse', `origin/${repoConfig.baseBranch}`], { cwd: repoConfig.localPath })
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

  // Build staging branch
  const staging = await buildStagingBranch(
    repoConfig.localPath,
    repoConfig.baseBranch,
    prNumbers,
    forge,
    repoConfig.repo,
    repoConfig.mergeQueue.stagingBranchPrefix,
  )

  batchManager.update(batch.id, {
    status: 'testing',
    stagingBranch: staging.stagingBranch,
    stagingSha: staging.stagingSha,
  })

  if (staging.ejected.length > 0) {
    logger.warn({ repo: repoConfig.repo, ejected: staging.ejected }, 'Some PRs ejected from batch due to conflicts')
  }

  logger.info({ repo: repoConfig.repo, batchId: batch.id, merged: staging.merged.length, testing: true }, 'Merge batch staged and pushed')
}
