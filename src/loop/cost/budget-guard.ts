import type Database from 'better-sqlite3'
import type { Config } from '../../config/schema.js'
import type { MetricsService } from '../../metrics/service.js'
import type { TokenUsage } from '../../workers/types.js'
import type { BudgetStatus, CostTracker } from '../cost.js'
import { updateContext } from '../context.js'
import { estimateTheoreticalCostUsd, estimateWorkerCost } from '../pricing.js'
import type { RunContext } from '../types.js'
import { logger } from '../../utils/logger.js'
import { parseUtcTimestampMs } from '../../utils/time.js'

export interface RunawayBudgetStatus {
  overBudget: boolean
  limit?: 'run_tokens' | 'issue_tokens' | 'daily_tokens' | 'run_wall_clock'
  actual?: number
  threshold?: number
}

export function checkRunawayBudget(
  db: Database.Database,
  costTracker: CostTracker,
  ctx: RunContext,
  loopConfig: Config['loop'],
): RunawayBudgetStatus {
  if (loopConfig.maxRunTokens > 0) {
    const runTokens = costTracker.getRunTokenUsage(ctx.runId).totalTokens
    if (runTokens >= loopConfig.maxRunTokens) {
      return {
        overBudget: true,
        limit: 'run_tokens',
        actual: runTokens,
        threshold: loopConfig.maxRunTokens,
      }
    }
  }

  if (loopConfig.maxIssueTokens > 0) {
    const issueTokens = getIssueChainTokenUsage(db, ctx.repo, ctx.issueNumber)
    if (issueTokens >= loopConfig.maxIssueTokens) {
      return {
        overBudget: true,
        limit: 'issue_tokens',
        actual: issueTokens,
        threshold: loopConfig.maxIssueTokens,
      }
    }
  }

  if (loopConfig.maxDailyTokens > 0) {
    const dailyTokens = costTracker.getDailyTokenUsage().totalTokens
    if (dailyTokens >= loopConfig.maxDailyTokens) {
      return {
        overBudget: true,
        limit: 'daily_tokens',
        actual: dailyTokens,
        threshold: loopConfig.maxDailyTokens,
      }
    }
  }

  if (loopConfig.maxRunWallClockMinutes > 0) {
    const startedAtMs = getRunStartedAtMs(db, ctx.runId)
    if (Number.isFinite(startedAtMs)) {
      const elapsedMinutes = (Date.now() - startedAtMs) / 60_000
      if (elapsedMinutes >= loopConfig.maxRunWallClockMinutes) {
        return {
          overBudget: true,
          limit: 'run_wall_clock',
          actual: elapsedMinutes,
          threshold: loopConfig.maxRunWallClockMinutes,
        }
      }
    }
  }

  return { overBudget: false }
}

export function describeRunawayBudgetBlock(status: RunawayBudgetStatus): string {
  if (
    !status.overBudget
    || status.limit === undefined
    || status.actual === undefined
    || status.threshold === undefined
  ) {
    return 'Runaway budget exceeded'
  }

  switch (status.limit) {
    case 'run_tokens':
      return `Run token budget exceeded (${Math.floor(status.actual)} >= ${Math.floor(status.threshold)} tokens)`
    case 'issue_tokens':
      return `Issue token budget exceeded (${Math.floor(status.actual)} >= ${Math.floor(status.threshold)} tokens)`
    case 'daily_tokens':
      return `Daily token budget exceeded (${Math.floor(status.actual)} >= ${Math.floor(status.threshold)} tokens)`
    case 'run_wall_clock':
      return `Run wall-clock budget exceeded (${status.actual.toFixed(1)} >= ${status.threshold} minutes)`
  }
}

export function runawayLimitToBlockReason(
  limit: RunawayBudgetStatus['limit'] | undefined,
): NonNullable<RunContext['blockReason']> {
  switch (limit) {
    case 'run_tokens':
      return 'run_token_limit'
    case 'issue_tokens':
      return 'issue_token_limit'
    case 'daily_tokens':
      return 'daily_token_limit'
    case 'run_wall_clock':
      return 'run_wall_clock_limit'
    default:
      return 'iteration_limit'
  }
}

export function applyEstimatedWorkerCost(
  ctx: RunContext,
  costTracker: CostTracker,
  costConfig: Config['cost'] | undefined,
  securityConfig: Config['security'],
  stepId: string,
  role: string,
  pricingIdentity: {
    role: string
    workerType: string
    pricingModel: string | null
    fallbackMinuteUsd?: number | null
  } | undefined,
  durationMs: number,
  tokenUsage?: TokenUsage,
  metrics?: MetricsService,
): {
  ctx: RunContext
  budget: BudgetStatus
} {
  const estimate = estimateWorkerCost({
    cost: costConfig,
    identity: {
      role,
      workerType: pricingIdentity?.workerType,
      pricingModel: pricingIdentity?.pricingModel,
      fallbackMinuteUsd: pricingIdentity?.fallbackMinuteUsd,
    },
    durationMs,
    tokenUsage,
    costModel: costConfig?.model,
  })
  const estimatedCost = estimate.usd
  const theoreticalCost = estimateTheoreticalCostUsd({
    cost: costConfig,
    identity: {
      role,
      workerType: pricingIdentity?.workerType,
      pricingModel: pricingIdentity?.pricingModel,
      fallbackMinuteUsd: pricingIdentity?.fallbackMinuteUsd,
    },
    durationMs,
    tokenUsage,
    costModel: costConfig?.model,
  })

  if (estimate.usedDefaultModelFallback && pricingIdentity?.pricingModel) {
    logger.warn(
      {
        runId: ctx.runId,
        phase: stepId,
        requestedModelKey: estimate.modelKey,
        resolvedModelKey: estimate.resolvedModelKey,
      },
      'Worker pricing model key missing from cost.pricing.models; falling back to default model pricing',
    )
  }

  if (estimatedCost <= 0 && !tokenUsage) {
    return {
      ctx,
      budget: { overBudget: false },
    }
  }

  const tokenSource = tokenUsage !== undefined ? 'reported_cli' : 'estimated_duration'
  const budget = costTracker.recordCostAndCheckBudget(
    ctx.runId,
    estimatedCost,
    tokenUsage,
    {
      stepId,
      workerType: pricingIdentity?.workerType ?? null,
      tokenSource,
      theoreticalCostUsd: theoreticalCost,
    },
    securityConfig,
    costConfig,
  )
  try { metrics?.incCostTokenSource(tokenSource) } catch { /* best-effort */ }
  if (estimatedCost > 0) {
    const agent = pricingIdentity?.workerType ?? 'unknown'
    try { metrics?.addEstimatedCost(ctx.repo, agent, estimatedCost) } catch { /* best-effort */ }
  }
  // Accumulate theoretical cost even when the real charge is $0 (subscription
  // models) so the run's metered-equivalent spend stays visible in the UI.
  return {
    ctx: updateContext(ctx, {
      estimatedCostUsd: Number((ctx.estimatedCostUsd + estimatedCost).toFixed(6)),
      theoreticalCostUsd: Number((ctx.theoreticalCostUsd + theoreticalCost).toFixed(6)),
    }),
    budget,
  }
}

function getIssueChainTokenUsage(
  db: Database.Database,
  repo: string,
  issueNumber: number,
): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + cache_read_tokens), 0) AS total_tokens
     FROM runs
     WHERE repo = ? AND issue_number = ? AND parent_run_id IS NULL`,
  ).get(repo, issueNumber) as { total_tokens: number | null } | undefined
  return row?.total_tokens ?? 0
}

function getRunStartedAtMs(db: Database.Database, runId: string): number {
  const row = db
    .prepare('SELECT started_at FROM runs WHERE id = ?')
    .get(runId) as { started_at: string | null } | undefined
  return parseUtcTimestampMs(row?.started_at)
}
