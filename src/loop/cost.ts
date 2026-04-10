import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { TokenUsage } from '../workers/types.js'
import { IssueManager } from '../state/issues.js'
import { RunManager } from '../state/runs.js'
import { utcDayKey } from '../utils/time.js'
import { logger } from '../utils/logger.js'

type TokenUsageInput = TokenUsage

export interface TokenUsageTotals {
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  totalTokens: number
}

interface CostRecordMetadata {
  stepId?: string
  workerType?: string | null
}

interface SubscriptionMeteredPolicy {
  advisoryThresholdUsd: number | null
  enforcePerRunLimit: boolean
  enforceDailyLimit: boolean
}

interface ResolvedCostPolicy {
  model: Config['cost']['model']
  subscriptionMetered: SubscriptionMeteredPolicy
}

export interface StepCostBreakdown {
  stepId: string
  costUsd: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  totalTokens: number
}

export interface WorkerCostBreakdown {
  workerType: string
  costUsd: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  totalTokens: number
}

export class CostTracker {
  private issueManager: IssueManager
  private advisoryWarnings = new Set<string>()

  constructor(private db: Database.Database) {
    this.issueManager = new IssueManager(db)
  }

  private persistCostRecord(
    runId: string,
    date: string,
    usage: TokenUsageTotals,
    usdAmount: number,
    costStepId: string | null,
    costWorkerType: string | null,
  ): void {
    const runUsageInsert = this.db
      .prepare(
        `INSERT INTO daily_run_usage (date, run_id)
         VALUES (?, ?)
         ON CONFLICT(date, run_id) DO NOTHING`,
      )
      .run(date, runId)
    const dailyRunCountIncrement = runUsageInsert.changes > 0 ? 1 : 0

    this.db
      .prepare(
        `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, total_cache_read_tokens)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           total_cost_usd = total_cost_usd + excluded.total_cost_usd,
           run_count = run_count + excluded.run_count,
           total_prompt_tokens = total_prompt_tokens + excluded.total_prompt_tokens,
           total_completion_tokens = total_completion_tokens + excluded.total_completion_tokens,
           total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens`,
      )
      .run(
        date,
        usdAmount,
        dailyRunCountIncrement,
        usage.promptTokens,
        usage.completionTokens,
        usage.cacheReadTokens,
      )

    this.db
      .prepare(
        `UPDATE runs
         SET estimated_cost_usd = estimated_cost_usd + ?,
             prompt_tokens = prompt_tokens + ?,
             completion_tokens = completion_tokens + ?,
             cache_read_tokens = cache_read_tokens + ?
         WHERE id = ?`,
      )
      .run(usdAmount, usage.promptTokens, usage.completionTokens, usage.cacheReadTokens, runId)

    if (costStepId !== null) {
      this.db
        .prepare(
          `INSERT INTO run_cost_entries (
             run_id,
             step_id,
             worker_type,
             cost_usd,
             prompt_tokens,
             completion_tokens,
             cache_read_tokens
           )
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          costStepId,
          costWorkerType,
          usdAmount,
          usage.promptTokens,
          usage.completionTokens,
          usage.cacheReadTokens,
        )
    }

    this.issueManager.syncFromRunId(runId)
  }

  /**
   * Record a cost entry for a run. Persists both USD amount and token counts.
   *
   * For subscription runs with $0 cost but real tokens, the tokens are still
   * recorded for analytics. The record is only skipped when both cost and
   * tokens are zero.
   *
   * Also updates daily aggregates and creates the per-run cost entry if stepId
   * is provided in metadata.
   */
  recordCost(
    runId: string,
    costUsd: number,
    tokenUsage?: TokenUsageInput,
    metadata: CostRecordMetadata = {},
  ): void {
    const amountUsd = Number(Math.max(0, costUsd).toFixed(6))
    const normalizedTokens = normalizeTokenUsage(tokenUsage)
    // Persist $0 cost + real tokens (subscription runs) — only skip when both are zero.
    if (amountUsd <= 0 && normalizedTokens.totalTokens <= 0) return

    const today = utcDayKey()
    const costStepId = metadata.stepId?.trim() ? metadata.stepId : null
    const costWorkerType = metadata.workerType?.trim() ? metadata.workerType : null
    const tx = this.db.transaction((
      id: string,
      date: string,
      usage: TokenUsageTotals,
      usdAmount: number,
    ) => {
      this.persistCostRecord(id, date, usage, usdAmount, costStepId, costWorkerType)
    })

    tx(runId, today, normalizedTokens, amountUsd)
  }

  /**
   * Record a cost entry and immediately check if the run has exceeded any budget limits.
   *
   * This is the primary entry point for worker cost recording during loop execution.
   * It records the cost (same as recordCost) and then evaluates budget constraints
   * using the configured security limits and cost policy.
   *
   * Returns a BudgetStatus indicating whether the run is over budget and which limit
   * was tripped (daily or per-run).
   */
  recordCostAndCheckBudget(
    runId: string,
    costUsd: number,
    tokenUsage: TokenUsageInput | undefined,
    metadata: CostRecordMetadata,
    limits: Config['security'],
    costPolicyInput: Config['cost']['model'] | Config['cost'] | undefined = 'pay-per-use',
  ): BudgetStatus {
    const amountUsd = Number(Math.max(0, costUsd).toFixed(6))
    const normalizedTokens = normalizeTokenUsage(tokenUsage)
    if (amountUsd <= 0 && normalizedTokens.totalTokens <= 0) {
      return this.checkBudget(runId, limits, costPolicyInput)
    }

    const today = utcDayKey()
    const costStepId = metadata.stepId?.trim() ? metadata.stepId : null
    const costWorkerType = metadata.workerType?.trim() ? metadata.workerType : null

    const tx = this.db.transaction((
      id: string,
      date: string,
      usage: TokenUsageTotals,
      usdAmount: number,
      securityLimits: Config['security'],
      policyInput: Config['cost']['model'] | Config['cost'] | undefined,
    ): BudgetStatus => {
      this.persistCostRecord(id, date, usage, usdAmount, costStepId, costWorkerType)
      return this.checkBudget(id, securityLimits, policyInput)
    })

    return tx(runId, today, normalizedTokens, amountUsd, limits, costPolicyInput)
  }

  /**
   * Get the total cost accumulated for today (UTC day) across all runs.
   * Returns 0 if no costs have been recorded today.
   */
  getDailyCost(): number {
    const today = utcDayKey()
    const row = this.db
      .prepare('SELECT total_cost_usd FROM daily_costs WHERE date = ?')
      .get(today) as { total_cost_usd: number } | undefined
    return row?.total_cost_usd ?? 0
  }

  /**
   * Get the accumulated cost for a specific run.
   * Returns 0 if the run doesn't exist or has no recorded cost.
   */
  getRunCost(runId: string): number {
    const row = this.db
      .prepare('SELECT estimated_cost_usd FROM runs WHERE id = ?')
      .get(runId) as { estimated_cost_usd: number } | undefined
    return row?.estimated_cost_usd ?? 0
  }

  /**
   * Get the total token usage for today (UTC day) across all runs.
   * Returns an object with all token counts set to 0 if no data exists.
   */
  getDailyTokenUsage(): TokenUsageTotals {
    const today = utcDayKey()
    const row = this.db
      .prepare('SELECT total_prompt_tokens, total_completion_tokens, total_cache_read_tokens FROM daily_costs WHERE date = ?')
      .get(today) as DailyTokenRow | undefined

    const promptTokens = row?.total_prompt_tokens ?? 0
    const completionTokens = row?.total_completion_tokens ?? 0
    const cacheReadTokens = row?.total_cache_read_tokens ?? 0
    return {
      promptTokens,
      completionTokens,
      cacheReadTokens,
      totalTokens: promptTokens + completionTokens + cacheReadTokens,
    }
  }

  getRunTokenUsage(runId: string): TokenUsageTotals {
    const row = this.db
      .prepare('SELECT prompt_tokens, completion_tokens, cache_read_tokens FROM runs WHERE id = ?')
      .get(runId) as RunTokenRow | undefined

    const promptTokens = row?.prompt_tokens ?? 0
    const completionTokens = row?.completion_tokens ?? 0
    const cacheReadTokens = row?.cache_read_tokens ?? 0
    return {
      promptTokens,
      completionTokens,
      cacheReadTokens,
      totalTokens: promptTokens + completionTokens + cacheReadTokens,
    }
  }

  getRunCostBreakdownByStep(runId: string): StepCostBreakdown[] {
    const rows = this.db
      .prepare(
        `SELECT
           step_id,
           SUM(cost_usd) AS cost_usd,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens
         FROM run_cost_entries
         WHERE run_id = ?
         GROUP BY step_id
         ORDER BY cost_usd DESC, step_id ASC`,
      )
      .all(runId) as Array<{
        step_id: string
        cost_usd: number | null
        prompt_tokens: number | null
        completion_tokens: number | null
        cache_read_tokens: number | null
      }>

    return rows.map((row) => {
      const promptTokens = row.prompt_tokens ?? 0
      const completionTokens = row.completion_tokens ?? 0
      const cacheReadTokens = row.cache_read_tokens ?? 0
      return {
        stepId: row.step_id,
        costUsd: row.cost_usd ?? 0,
        promptTokens,
        completionTokens,
        cacheReadTokens,
        totalTokens: promptTokens + completionTokens + cacheReadTokens,
      }
    })
  }

  getDailyCostBreakdownByStep(date: string = utcDayKey()): StepCostBreakdown[] {
    const rows = this.db
      .prepare(
        `SELECT
           step_id,
           SUM(cost_usd) AS cost_usd,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens
         FROM run_cost_entries
         WHERE date(created_at) = ?
         GROUP BY step_id
         ORDER BY cost_usd DESC, step_id ASC`,
      )
      .all(date) as Array<{
        step_id: string
        cost_usd: number | null
        prompt_tokens: number | null
        completion_tokens: number | null
        cache_read_tokens: number | null
      }>

    return rows.map((row) => {
      const promptTokens = row.prompt_tokens ?? 0
      const completionTokens = row.completion_tokens ?? 0
      const cacheReadTokens = row.cache_read_tokens ?? 0
      return {
        stepId: row.step_id,
        costUsd: row.cost_usd ?? 0,
        promptTokens,
        completionTokens,
        cacheReadTokens,
        totalTokens: promptTokens + completionTokens + cacheReadTokens,
      }
    })
  }

  getDailyCostBreakdownByWorker(date: string = utcDayKey()): WorkerCostBreakdown[] {
    const rows = this.db
      .prepare(
        `SELECT
           COALESCE(worker_type, 'unknown') AS worker_type,
           SUM(cost_usd) AS cost_usd,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens
         FROM run_cost_entries
         WHERE date(created_at) = ?
         GROUP BY worker_type
         ORDER BY cost_usd DESC, worker_type ASC`,
      )
      .all(date) as Array<{
        worker_type: string
        cost_usd: number | null
        prompt_tokens: number | null
        completion_tokens: number | null
        cache_read_tokens: number | null
      }>

    return rows.map((row) => {
      const promptTokens = row.prompt_tokens ?? 0
      const completionTokens = row.completion_tokens ?? 0
      const cacheReadTokens = row.cache_read_tokens ?? 0
      return {
        workerType: row.worker_type,
        costUsd: row.cost_usd ?? 0,
        promptTokens,
        completionTokens,
        cacheReadTokens,
        totalTokens: promptTokens + completionTokens + cacheReadTokens,
      }
    })
  }

  /**
   * Evaluate whether a run has crossed any spend limit.
   * Returns a discriminated status so callers can build messages that name
   * the specific limit that tripped (daily vs per-run) instead of guessing.
   *
   * In `subscription` mode, enforcement is always skipped.
   * In `subscription-metered` mode, warnings can be emitted while enforcement
   * is optional per configured knob.
   *
   * A non-null `cost_budget_override_usd` on the run row overrides the
   * per-run cap with the stored value AND exempts the run from the daily
   * cap. Operators grant this override to push a specific run through when
   * they accept the extra spend.
   *
   * A non-null `daily_cost_cap_override_usd` on today's `daily_costs` row
   * replaces `limits.maxDailyCostUsd` for today only. It auto-expires when
   * the UTC day rolls over (next day's row starts NULL).
   */
  checkBudget(
    runId: string,
    limits: Config['security'],
    costPolicyInput: Config['cost']['model'] | Config['cost'] | undefined = 'pay-per-use',
  ): BudgetStatus {
    const policy = resolveCostPolicy(costPolicyInput)

    if (policy.model === 'subscription') {
      return { overBudget: false }
    }

    const override = this.getRunBudgetOverride(runId)
    const runCost = this.getRunCost(runId)
    const effectivePerRunLimit = override ?? limits.maxCostPerRunUsd
    const runOverLimit = runCost >= effectivePerRunLimit

    const dailyCost = this.getDailyCost()
    const dailyCapOverride = this.getDailyCapOverride()
    const effectiveDailyLimit = dailyCapOverride ?? limits.maxDailyCostUsd
    const dailyOverLimit = dailyCost >= effectiveDailyLimit

    if (policy.model === 'subscription-metered') {
      const advisoryThreshold = policy.subscriptionMetered.advisoryThresholdUsd
      if (advisoryThreshold !== null) {
        if (runCost >= advisoryThreshold) {
          this.logSubscriptionMeteredWarningOnce(
            `${runId}:advisory:run:${advisoryThreshold}`,
            {
              runId,
              thresholdUsd: advisoryThreshold,
              runCostUsd: runCost,
            },
            'subscription-metered advisory threshold exceeded (run)',
          )
        }
        if (dailyCost >= advisoryThreshold) {
          this.logSubscriptionMeteredWarningOnce(
            `${runId}:advisory:daily:${advisoryThreshold}:${utcDayKey()}`,
            {
              runId,
              thresholdUsd: advisoryThreshold,
              dailyCostUsd: dailyCost,
            },
            'subscription-metered advisory threshold exceeded (daily)',
          )
        }
      }

      if (runOverLimit && !policy.subscriptionMetered.enforcePerRunLimit) {
        this.logSubscriptionMeteredWarningOnce(
          `${runId}:soft:per-run:${effectivePerRunLimit}`,
          {
            runId,
            runCostUsd: runCost,
            effectivePerRunLimitUsd: effectivePerRunLimit,
          },
          'subscription-metered soft per-run limit exceeded',
        )
      }

      if (runOverLimit && policy.subscriptionMetered.enforcePerRunLimit) {
        return {
          overBudget: true,
          limit: 'per-run',
          actualUsd: runCost,
          limitUsd: effectivePerRunLimit,
        }
      }

      if (override !== null) {
        return { overBudget: false }
      }

      if (dailyOverLimit && !policy.subscriptionMetered.enforceDailyLimit) {
        this.logSubscriptionMeteredWarningOnce(
          `${runId}:soft:daily:${effectiveDailyLimit}:${utcDayKey()}`,
          {
            runId,
            dailyCostUsd: dailyCost,
            effectiveDailyLimitUsd: effectiveDailyLimit,
          },
          'subscription-metered soft daily limit exceeded',
        )
      }

      if (dailyOverLimit && policy.subscriptionMetered.enforceDailyLimit) {
        return {
          overBudget: true,
          limit: 'daily',
          actualUsd: dailyCost,
          limitUsd: effectiveDailyLimit,
        }
      }

      return { overBudget: false }
    }

    if (runOverLimit) {
      return {
        overBudget: true,
        limit: 'per-run',
        actualUsd: runCost,
        limitUsd: effectivePerRunLimit,
      }
    }

    // Override grants a one-time bypass of the daily cap so a stuck run can
    // make forward progress even if the day has already blown past the limit.
    if (override !== null) {
      return { overBudget: false }
    }

    if (dailyOverLimit) {
      return {
        overBudget: true,
        limit: 'daily',
        actualUsd: dailyCost,
        limitUsd: effectiveDailyLimit,
      }
    }

    return { overBudget: false }
  }

  /**
   * Read the cost budget override for a run, or null if no override is set.
   */
  getRunBudgetOverride(runId: string): number | null {
    const row = this.db
      .prepare('SELECT cost_budget_override_usd FROM runs WHERE id = ?')
      .get(runId) as { cost_budget_override_usd: number | null } | undefined
    if (!row) return null
    return row.cost_budget_override_usd ?? null
  }

  /**
   * Grant a per-run cost override. Pass null to clear it.
   * When set, the value becomes the run's per-run cap and the daily cap
   * is bypassed for this run.
   */
  setRunBudgetOverride(runId: string, overrideUsd: number | null): void {
    if (overrideUsd !== null) {
      if (!Number.isFinite(overrideUsd) || overrideUsd <= 0) {
        throw new Error(`cost budget override must be a positive finite number, got ${overrideUsd}`)
      }
    }
    new RunManager(this.db).setCostBudgetOverride(runId, overrideUsd)
  }

  /**
   * Read the daily cost cap override for a UTC day (defaults to today).
   * Returns null when no override is set.
   */
  getDailyCapOverride(date: string = utcDayKey()): number | null {
    const row = this.db
      .prepare('SELECT daily_cost_cap_override_usd FROM daily_costs WHERE date = ?')
      .get(date) as { daily_cost_cap_override_usd: number | null } | undefined
    if (!row) return null
    return row.daily_cost_cap_override_usd ?? null
  }

  /**
   * Set or clear the daily cost cap override for a UTC day (defaults to
   * today). Upserts the `daily_costs` row so the override works even on a
   * day with no recorded spend yet. The override auto-expires when the UTC
   * day rolls over — operators do not need to clear it manually.
   */
  setDailyCapOverride(overrideUsd: number | null, date: string = utcDayKey()): void {
    if (overrideUsd !== null) {
      if (!Number.isFinite(overrideUsd) || overrideUsd <= 0) {
        throw new Error(`daily cap override must be a positive finite number, got ${overrideUsd}`)
      }
    }
    this.db
      .prepare(
        `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, total_cache_read_tokens, daily_cost_cap_override_usd)
         VALUES (?, 0, 0, 0, 0, 0, ?)
         ON CONFLICT(date) DO UPDATE SET daily_cost_cap_override_usd = excluded.daily_cost_cap_override_usd`,
      )
      .run(date, overrideUsd)
  }

  /**
   * Reset daily cost counters for a specific UTC day (defaults to today).
   * Zeros `total_cost_usd`, `total_prompt_tokens`, `total_completion_tokens`,
   * and `total_cache_read_tokens` while preserving `daily_cost_cap_override_usd`.
   *
   * Returns the previous daily cost before resetting.
   */
  resetDailyCosts(date: string = utcDayKey()): { previousCostUsd: number } {
    const row = this.db
      .prepare('SELECT total_cost_usd FROM daily_costs WHERE date = ?')
      .get(date) as { total_cost_usd: number } | undefined
    const previousCostUsd = row?.total_cost_usd ?? 0

    this.db
      .prepare(
        `UPDATE daily_costs
         SET total_cost_usd = 0,
             total_prompt_tokens = 0,
             total_completion_tokens = 0,
             total_cache_read_tokens = 0
         WHERE date = ?`,
      )
      .run(date)

    logger.info({ date, previousCostUsd }, 'Reset daily cost counters')

    return { previousCostUsd }
  }

  private logSubscriptionMeteredWarningOnce(
    key: string,
    data: Record<string, unknown>,
    message: string,
  ): void {
    if (this.advisoryWarnings.has(key)) return
    this.advisoryWarnings.add(key)
    logger.warn(data, message)
  }
}

export type BudgetStatus =
  | { overBudget: false }
  | {
      overBudget: true
      limit: 'daily' | 'per-run'
      actualUsd: number
      limitUsd: number
    }

/** Human-readable message naming the specific limit that tripped. */
export function describeBudgetBlock(
  status: Extract<BudgetStatus, { overBudget: true }>,
): string {
  const label = status.limit === 'daily' ? 'Daily cost limit' : 'Per-run cost limit'
  return `${label} exceeded: $${status.actualUsd.toFixed(2)} >= $${status.limitUsd.toFixed(2)}`
}

/** Actionable recovery hint shown alongside the block reason. */
export function costLimitRecoveryHint(limit: 'daily' | 'per-run'): string {
  if (limit === 'daily') {
    return (
      'Raise today\'s cap via the web dashboard or Settings (auto-expires at 00:00 UTC), ' +
      'grant this run a budget override, ' +
      'or wait until 00:00 UTC for the daily counter to reset.'
    )
  }
  return (
    'Raise `security.maxCostPerRunUsd` via Settings or grant this run a budget override to continue.'
  )
}

function normalizeTokenUsage(tokenUsage: TokenUsageInput | undefined): TokenUsageTotals {
  const promptTokens = normalizeTokenCount(tokenUsage?.promptTokens)
  const completionTokens = normalizeTokenCount(tokenUsage?.completionTokens)
  const cacheReadTokens = normalizeTokenCount(tokenUsage?.cacheReadTokens)
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    totalTokens: promptTokens + completionTokens + cacheReadTokens,
  }
}

function normalizeTokenCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

interface DailyTokenRow {
  total_prompt_tokens: number | null
  total_completion_tokens: number | null
  total_cache_read_tokens: number | null
}

interface RunTokenRow {
  prompt_tokens: number | null
  completion_tokens: number | null
  cache_read_tokens: number | null
}

function resolveCostPolicy(
  input: Config['cost']['model'] | Config['cost'] | undefined,
): ResolvedCostPolicy {
  if (typeof input === 'string') {
    return {
      model: input,
      subscriptionMetered: {
        advisoryThresholdUsd: null,
        enforcePerRunLimit: false,
        enforceDailyLimit: false,
      },
    }
  }

  const model = input?.model ?? 'pay-per-use'
  const subscriptionMetered = input?.subscriptionMetered
  return {
    model,
    subscriptionMetered: {
      advisoryThresholdUsd: subscriptionMetered?.advisoryThresholdUsd ?? null,
      enforcePerRunLimit: subscriptionMetered?.enforcePerRunLimit ?? false,
      enforceDailyLimit: subscriptionMetered?.enforceDailyLimit ?? false,
    },
  }
}
