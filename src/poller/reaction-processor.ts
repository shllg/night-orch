import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { LeaseManager } from '../state/leases.js'
import type { RunManager } from '../state/runs.js'
import { scanAndHandleReactions } from '../runner/reaction-scan.js'
import { processCommentCommands } from '../runner/comment-commands.js'
import type { OrchestrationCache } from '../runner/orchestration-cache.js'
import type { MetricsService } from '../metrics/service.js'
import { processMergeQueue } from '../merge-queue/runner.js'
import { scanCostBlockedRuns } from '../ops/cost-resume.js'
import { logger } from '../utils/logger.js'

/**
 * R6 boundary: run every "pre-discovery" reactive task for a repo
 * before we look for new issues to work on. The four steps here are
 * intentionally independent — each wraps its own try/catch so a
 * single failure doesn't block the others — and their relative
 * ordering is the same as it was inside `pollOnce` pre-refactor:
 *
 *   1. Reaction scan on review-ready PRs (CI failures, human reviews)
 *   2. Merge queue processing (merge pending batches)
 *   3. Cost-blocked run resume (auto-resume when budget clears)
 *   4. `/orch retry|rebase|continue|cancel` comment commands
 *
 * After this function returns, the caller kicks off issue discovery.
 */

export interface ProcessRepoReactionsParams {
  config: Config
  db: Database.Database
  forge: ForgeAdapter
  repoConfig: Config['repos'][number]
  runManager: RunManager
  leaseManager: LeaseManager
  botUser: string
  cache: OrchestrationCache
  metrics?: MetricsService
}

export async function processRepoReactions(
  params: ProcessRepoReactionsParams,
): Promise<void> {
  const { config, db, forge, repoConfig, runManager, leaseManager, botUser, cache, metrics } = params

  const results = await Promise.allSettled([
    scanAndHandleReactions({
      db,
      forge,
      runManager,
      repoConfig,
      maxAttemptChainLength: config.loop.maxAttemptChainLength,
      cache,
      config,
      botUser,
      metrics,
    }),
    processMergeQueue(db, forge, repoConfig, { config, botUser }),
    scanCostBlockedRuns(db, config, forge, repoConfig, botUser),
    processCommentCommands({
      config,
      db,
      forge,
      runManager,
      leaseManager,
      repoConfig,
      botUser,
      cache,
    }),
  ])

  const warnings = [
    'Reaction scan failed — continuing with issue discovery',
    'Merge queue processing failed — continuing',
    'Cost-resume scan failed — continuing',
    'Comment command processing failed — continuing',
  ]

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      logger.warn({ repo: repoConfig.repo, err: result.reason }, warnings[index])
    }
  }
}
