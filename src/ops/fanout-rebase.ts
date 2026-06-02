import type Database from 'better-sqlite3'
import type { Config, RepoConfig } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { hasOpenRebaseAttempt } from '../state/attempts.js'
import { RebaseFanoutManager } from '../state/rebase-fanouts.js'
import { RunManager, type RunOperationIntent, type RunStatus } from '../state/runs.js'
import { logger } from '../utils/logger.js'
import { queueRebase as defaultQueueRebase, type QueueRebaseParams } from './rebase-and-check.js'

const BENIGN_SKIP_REASONS = new Set([
  'Run is already queued',
  'Run is already running',
  'chain_exhausted',
  'No run with branch found for this issue',
])

export interface FanoutCandidateInput {
  id: string
  repo: string
  issueNumber: number
  prNumber: number | null
  status: RunStatus
  operationIntent: RunOperationIntent
  hasOpenRebaseAttempt: boolean
}

export interface FanoutCandidate {
  id: string
  repo: string
  issueNumber: number
  prNumber: number
  status: RunStatus
}

export function selectFanoutCandidates(
  runs: FanoutCandidateInput[],
  source: { sourcePrNumber: number },
  options: { maxFanout: number },
): FanoutCandidate[] {
  return runs
    .filter((run) => run.prNumber !== null)
    .filter((run) => run.prNumber !== source.sourcePrNumber)
    .filter((run) => run.status === 'review_ready' || run.status === 'blocked' || run.status === 'error')
    .filter((run) => !run.hasOpenRebaseAttempt)
    // Deterministic ordering by issueNumber asc — makes maxFanout truncation
    // predictable so tests and operators see the same surviving set.
    .sort((a, b) => a.issueNumber - b.issueNumber)
    .slice(0, options.maxFanout)
    .map((run) => ({
      id: run.id,
      repo: run.repo,
      issueNumber: run.issueNumber,
      prNumber: run.prNumber!,
      status: run.status,
    }))
}

type QueueRebaseFn = (params: QueueRebaseParams) => Promise<{ queued: boolean; reason: string }>

export interface FanoutDeps {
  db: Database.Database
  repoConfig: RepoConfig
  forge: ForgeAdapter
  config: Config
  sourcePrNumber: number
  baseBranch: string
  botUser: string
  queueRebase?: QueueRebaseFn
  fanouts?: RebaseFanoutManager
  metrics?: {
    incRebaseFanout?: (repo: string, baseBranch: string) => void
    incRebaseFanoutSibling?: (repo: string) => void
  }
}

export interface FanoutResult {
  queued: number
  skipped: number
  failures: number
  alreadyFannedOut: boolean
  skippedDisabled: boolean
}

export async function fanoutRebaseAfterMerge(deps: FanoutDeps): Promise<FanoutResult> {
  const { db, repoConfig, forge, config, sourcePrNumber, baseBranch, botUser } = deps
  const fanouts = deps.fanouts ?? new RebaseFanoutManager(db)
  const queueRebase = deps.queueRebase ?? defaultQueueRebase
  const autoRebase = repoConfig.autoRebaseOnMerge

  if (!autoRebase.enabled) {
    return { queued: 0, skipped: 0, failures: 0, alreadyFannedOut: false, skippedDisabled: true }
  }

  if (fanouts.has(repoConfig.repo, sourcePrNumber)) {
    return { queued: 0, skipped: 0, failures: 0, alreadyFannedOut: true, skippedDisabled: false }
  }

  const runManager = new RunManager(db)
  const localCandidates = selectFanoutCandidates(
    runManager.listLiveTopLevelByRepo(repoConfig.repo).map((run) => ({
      id: run.id,
      repo: run.repo,
      issueNumber: run.issueNumber,
      prNumber: run.prNumber,
      status: run.status,
      operationIntent: run.operationIntent,
      hasOpenRebaseAttempt: hasOpenRebaseAttempt(db, run.repo, run.issueNumber),
    })),
    { sourcePrNumber },
    { maxFanout: autoRebase.maxFanout },
  )

  if (!forge.getPR) {
    logger.warn(
      { repo: repoConfig.repo, sourcePrNumber },
      'Skipping fan-out rebase because forge adapter cannot fetch PR details',
    )
    return {
      queued: 0,
      skipped: localCandidates.length,
      failures: 0,
      alreadyFannedOut: false,
      skippedDisabled: false,
    }
  }

  const enriched: FanoutCandidate[] = []
  for (const candidate of localCandidates) {
    try {
      const pr = await forge.getPR(repoConfig.repo, candidate.prNumber)
      if (pr.state === 'open' && pr.baseBranch === baseBranch) {
        enriched.push(candidate)
      }
    } catch (err) {
      logger.warn(
        { repo: repoConfig.repo, prNumber: candidate.prNumber, err },
        'Failed to enrich fan-out candidate PR',
      )
    }
  }

  let queued = 0
  let skipped = 0
  let failures = 0
  const maxAttemptChainLength = autoRebase.maxChainLength
    ?? config.loop.maxAttemptChainLength * 2

  for (const candidate of enriched) {
    try {
      const result = await queueRebase({
        db,
        forge,
        repoConfig,
        issueNumber: candidate.issueNumber,
        botUser,
        maxAttemptChainLength,
        trigger: { kind: 'fanout', sourcePr: sourcePrNumber },
        strategyOverride: autoRebase.strategy,
      })

      if (result.queued) {
        queued += 1
      } else if (BENIGN_SKIP_REASONS.has(result.reason)) {
        skipped += 1
      } else {
        failures += 1
        logger.warn(
          { repo: repoConfig.repo, issueNumber: candidate.issueNumber, reason: result.reason },
          'Fan-out rebase queue returned non-benign skip',
        )
      }
    } catch (err) {
      failures += 1
      logger.warn(
        { repo: repoConfig.repo, sourcePrNumber, issueNumber: candidate.issueNumber, err },
        'Fan-out rebase queue failed',
      )
    }
  }

  if (failures === 0) {
    fanouts.mark(repoConfig.repo, sourcePrNumber, queued)
  }

  deps.metrics?.incRebaseFanout?.(repoConfig.repo, baseBranch)
  for (let i = 0; i < queued; i += 1) {
    deps.metrics?.incRebaseFanoutSibling?.(repoConfig.repo)
  }

  return { queued, skipped, failures, alreadyFannedOut: false, skippedDisabled: false }
}
