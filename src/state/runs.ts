import type Database from 'better-sqlite3'
import { generateRunId } from '../utils/ids.js'
import { nowUtcIso } from '../utils/time.js'
import { IssueManager } from './issues.js'
import { logger } from '../utils/logger.js'
import {
  assertNever,
  blocked,
  blockedReasonFromLegacy,
  blockedReasonToLegacy,
  type BlockedReason,
  type RunState,
} from '../loop/state.js'

export type RunStatus = 'queued' | 'running' | 'blocked' | 'review_ready' | 'error' | 'completed'
export type RunOperationIntent = 'auto' | 'continue' | 'retry' | 'rebase' | 'refresh'
export type RunManualState = 'none' | 'awaiting_rebase_resolution'

export interface RunRecord {
  id: string
  repo: string
  issueNumber: number
  issueTitle: string | null
  issueNodeId: string | null
  status: RunStatus
  planner: string
  coder: string
  reviewer: string
  iterationCount: number
  currentPhase: string | null
  phaseData: Record<string, unknown> | null
  startedAt: string | null
  endedAt: string | null
  lastError: string | null
  prNumber: number | null
  prTitle: string | null
  branchName: string | null
  branchSlug: string | null
  worktreePath: string | null
  estimatedCostUsd: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  blockReason: string | null
  operationIntent: RunOperationIntent
  manualState: RunManualState
  controlPayload: Record<string, unknown> | null
  parentRunId: string | null
  /**
   * Number of auto-retries performed against this run row. Increments when
   * the poller transitions the row back to `queued` after an error so that
   * `maxAutoRetries` is enforced across replay attempts on the same row.
   */
  retryCount: number
}

export interface CreateRunParams {
  repo: string
  issueNumber: number
  issueTitle?: string | null
  issueNodeId: string | null
  planner: string
  coder: string
  reviewer: string
  parentRunId?: string | null
}

export class RunManager {
  private issueManager: IssueManager

  constructor(private db: Database.Database) {
    this.issueManager = new IssueManager(db)
  }

  create(params: CreateRunParams): RunRecord {
    const id = generateRunId()
    const now = nowUtcIso()

    const createTx = this.db.transaction(() => {
      // Uniqueness only applies to top-level runs. Sub-runs (identified by
      // a non-null `parent_run_id`) share the same repo+issue as their
      // parent by design — decomposition and parallel subtasks both spawn
      // multiple sub-runs on a single parent issue — and must not collide
      // with the parent or with each other.
      const activeExisting = params.parentRunId
        ? undefined
        : (this.db
            .prepare(
              `SELECT id, status
               FROM runs
               WHERE repo = ?
                 AND issue_number = ?
                 AND parent_run_id IS NULL
                 AND status IN ('queued', 'running', 'blocked', 'review_ready', 'error')
               LIMIT 1`,
            )
            .get(params.repo, params.issueNumber) as { id: string; status: string } | undefined)

      if (activeExisting) {
        throw new Error(
          `Cannot create a new run for ${params.repo}#${params.issueNumber}: active run ${activeExisting.id} is ${activeExisting.status}`,
        )
      }

      this.db
        .prepare(
          `INSERT INTO runs (id, repo, issue_number, issue_title, issue_node_id, status, planner, coder, reviewer, operation_intent, manual_state, parent_run_id, started_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, 'auto', 'none', ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.repo,
          params.issueNumber,
          params.issueTitle ?? null,
          params.issueNodeId,
          params.planner,
          params.coder,
          params.reviewer,
          params.parentRunId ?? null,
          now,
          now,
          now,
        )

      this.issueManager.syncFromRunId(id)
    })

    createTx()

    return this.getById(id)!
  }

  update(id: string, fields: Partial<RunRecord>): void {
    const allowed = [
      'status',
      'issueTitle',
      'iterationCount',
      'currentPhase',
      'phaseData',
      'endedAt',
      'lastError',
      'prNumber',
      'prTitle',
      'branchName',
      'branchSlug',
      'worktreePath',
      'estimatedCostUsd',
      'promptTokens',
      'completionTokens',
      'cacheReadTokens',
      'blockReason',
      'operationIntent',
      'manualState',
      'controlPayload',
      'parentRunId',
    ] as const

    const columnMap: Record<string, string> = {
      issueNumber: 'issue_number',
      issueTitle: 'issue_title',
      issueNodeId: 'issue_node_id',
      iterationCount: 'iteration_count',
      currentPhase: 'current_phase',
      phaseData: 'phase_data',
      startedAt: 'started_at',
      endedAt: 'ended_at',
      lastError: 'last_error',
      prNumber: 'pr_number',
      prTitle: 'pr_title',
      branchName: 'branch_name',
      branchSlug: 'branch_slug',
      worktreePath: 'worktree_path',
      estimatedCostUsd: 'estimated_cost_usd',
      promptTokens: 'prompt_tokens',
      completionTokens: 'completion_tokens',
      cacheReadTokens: 'cache_read_tokens',
      blockReason: 'block_reason',
      operationIntent: 'operation_intent',
      manualState: 'manual_state',
      controlPayload: 'control_payload',
      parentRunId: 'parent_run_id',
    }

    const setClauses: string[] = []
    const values: unknown[] = []

    for (const key of allowed) {
      if (key in fields) {
        const col = columnMap[key] ?? key
        let val: unknown = fields[key]
        if ((key === 'phaseData' || key === 'controlPayload') && val !== null) {
          val = JSON.stringify(val)
        }
        setClauses.push(`${col} = ?`)
        values.push(val)
      }
    }

    if (setClauses.length === 0) return

    const now = nowUtcIso()
    setClauses.push('updated_at = ?')
    values.push(now)

    // Bridge to the immutable-attempts invariant: when a row transitions to
    // the terminal 'completed' status, also stamp `terminated_at` so the
    // one-live-top-level-per-issue unique index (migration 024) permits a
    // successor attempt to be inserted. retry/continue/rebase finalize
    // earlier states (blocked/error/review_ready) explicitly via
    // AttemptController in R0c.
    if (fields.status === 'completed') {
      setClauses.push('terminated_at = COALESCE(terminated_at, ?)')
      values.push(now)
    }

    values.push(id)

    const updateTx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE runs SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...values)
      this.issueManager.syncFromRunId(id)
    })

    updateTx()
  }

  updateIfStatus(id: string, allowedStatuses: readonly RunStatus[], fields: Partial<RunRecord>): boolean {
    if (allowedStatuses.length === 0) return false

    const allowed = [
      'status',
      'issueTitle',
      'iterationCount',
      'currentPhase',
      'phaseData',
      'endedAt',
      'lastError',
      'prNumber',
      'prTitle',
      'branchName',
      'branchSlug',
      'worktreePath',
      'estimatedCostUsd',
      'promptTokens',
      'completionTokens',
      'cacheReadTokens',
      'blockReason',
      'operationIntent',
      'manualState',
      'controlPayload',
      'parentRunId',
    ] as const

    const columnMap: Record<string, string> = {
      issueNumber: 'issue_number',
      issueTitle: 'issue_title',
      issueNodeId: 'issue_node_id',
      iterationCount: 'iteration_count',
      currentPhase: 'current_phase',
      phaseData: 'phase_data',
      startedAt: 'started_at',
      endedAt: 'ended_at',
      lastError: 'last_error',
      prNumber: 'pr_number',
      prTitle: 'pr_title',
      branchName: 'branch_name',
      branchSlug: 'branch_slug',
      worktreePath: 'worktree_path',
      estimatedCostUsd: 'estimated_cost_usd',
      promptTokens: 'prompt_tokens',
      completionTokens: 'completion_tokens',
      cacheReadTokens: 'cache_read_tokens',
      blockReason: 'block_reason',
      operationIntent: 'operation_intent',
      manualState: 'manual_state',
      controlPayload: 'control_payload',
      parentRunId: 'parent_run_id',
    }

    const setClauses: string[] = []
    const values: unknown[] = []

    for (const key of allowed) {
      if (key in fields) {
        const col = columnMap[key] ?? key
        let val: unknown = fields[key]
        if ((key === 'phaseData' || key === 'controlPayload') && val !== null) {
          val = JSON.stringify(val)
        }
        setClauses.push(`${col} = ?`)
        values.push(val)
      }
    }

    if (setClauses.length === 0) return false

    const now = nowUtcIso()
    setClauses.push('updated_at = ?')
    values.push(now)

    // Mirror of update(): auto-stamp terminated_at on transition to
    // 'completed' to satisfy the one-live-head invariant.
    if (fields.status === 'completed') {
      setClauses.push('terminated_at = COALESCE(terminated_at, ?)')
      values.push(now)
    }

    values.push(id, ...allowedStatuses)

    const placeholders = allowedStatuses.map(() => '?').join(', ')
    const updateTx = this.db.transaction(() => {
      const result = this.db
        .prepare(`UPDATE runs SET ${setClauses.join(', ')} WHERE id = ? AND status IN (${placeholders})`)
        .run(...values)
      if (result.changes > 0) {
        this.issueManager.syncFromRunId(id)
        return true
      }
      return false
    })

    return updateTx()
  }

  getById(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  getByRepoAndIssue(repo: string, issueNumber: number): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM runs
         WHERE repo = ?
           AND issue_number = ?
         ORDER BY
           COALESCE(julianday(created_at), 0) DESC,
           COALESCE(julianday(updated_at), 0) DESC,
           rowid DESC,
           id DESC
         LIMIT 1`,
      )
      .get(repo, issueNumber) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  getLatestQueuedByIssue(repo: string, issueNumber: number): RunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE repo = ? AND issue_number = ? AND status = 'queued' ORDER BY created_at DESC LIMIT 1")
      .get(repo, issueNumber) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  /**
   * Count auto-retries performed for an issue. Prefers the active run's
   * `retry_count` column (accurate across replay retries on the same row),
   * and falls back to counting historical `error` rows in a time window
   * for issues without an active run. Used to decide whether to auto-retry
   * or give up.
   */
  countRecentErrors(repo: string, issueNumber: number, windowMinutes = 60): number {
    const activeRow = this.db
      .prepare(
        `SELECT retry_count
         FROM runs
         WHERE repo = ? AND issue_number = ?
         ORDER BY COALESCE(julianday(created_at), 0) DESC, rowid DESC
         LIMIT 1`,
      )
      .get(repo, issueNumber) as { retry_count: number | null } | undefined
    if (activeRow) {
      return activeRow.retry_count ?? 0
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM runs
         WHERE repo = ? AND issue_number = ? AND status = 'error'
         AND datetime(ended_at) > datetime('now', '-' || ? || ' minutes')`,
      )
      .get(repo, issueNumber, windowMinutes) as { cnt: number } | undefined
    return row?.cnt ?? 0
  }

  /**
   * Increment the retry counter on a run row. Called by the poller when
   * transitioning an errored run back to `queued` for an auto-retry. Returns
   * the new value so callers can enforce `maxAutoRetries` without a second
   * read.
   */
  incrementRetryCount(id: string): number {
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE runs SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?')
        .run(nowUtcIso(), id)
      const row = this.db
        .prepare('SELECT retry_count FROM runs WHERE id = ?')
        .get(id) as { retry_count: number | null } | undefined
      return row?.retry_count ?? 0
    })
    return tx()
  }

  /**
   * Directly update the current_phase + optionally phase_data columns for
   * checkpoint writes. When `phaseData` is null the existing phase_data is
   * preserved (used by `phaseStarted` which only sets `current_phase`).
   * Triggers issue-sync side effects like the general `update()` method.
   */
  updatePhaseCheckpoint(
    id: string,
    currentPhase: string,
    phaseData: string | null,
    iteration?: number | null,
  ): void {
    const now = nowUtcIso()
    const tx = this.db.transaction(() => {
      if (phaseData !== null) {
        this.db
          .prepare(
            'UPDATE runs SET current_phase = ?, phase_data = ?, iteration_count = COALESCE(?, iteration_count), updated_at = ? WHERE id = ?',
          )
          .run(currentPhase, phaseData, iteration ?? null, now, id)
      } else {
        this.db
          .prepare(
            'UPDATE runs SET current_phase = ?, iteration_count = COALESCE(?, iteration_count), updated_at = ? WHERE id = ?',
          )
          .run(currentPhase, iteration ?? null, now, id)
      }
      this.issueManager.syncFromRunId(id)
    })
    tx()
  }

  /**
   * Update only the phase_data JSON blob (for persistRunState, decision
   * outcomes, etc).
   */
  updatePhaseData(id: string, phaseData: string): void {
    this.db
      .prepare('UPDATE runs SET phase_data = ?, updated_at = ? WHERE id = ?')
      .run(phaseData, nowUtcIso(), id)
  }

  /**
   * Set the per-run cost budget override.
   */
  setCostBudgetOverride(id: string, overrideUsd: number | null): void {
    this.db
      .prepare('UPDATE runs SET cost_budget_override_usd = ? WHERE id = ?')
      .run(overrideUsd, id)
  }

  /**
   * Apply a run update and clear the per-run budget override atomically.
   * Used by finalization paths where a crash between the two writes would
   * leave terminal state out of sync with retry/cost controls.
   */
  updateAndClearCostBudgetOverride(id: string, fields: Partial<RunRecord>): void {
    const tx = this.db.transaction(() => {
      this.update(id, fields)
      this.setCostBudgetOverride(id, null)
    })
    tx()
  }

  /**
   * Compact the phase_data to a summary blob for retention. Does NOT
   * trigger issue-sync because the run is already in a terminal state.
   */
  compactPhaseData(id: string, summaryJson: string): void {
    this.db
      .prepare('UPDATE runs SET phase_data = ? WHERE id = ?')
      .run(summaryJson, id)
  }

  /**
   * Get the most recent non-queued, non-running run for an issue,
   * excluding the current run. Used to check if prior work is tainted.
   */
  getLatestFinishedByIssue(repo: string, issueNumber: number, excludeRunId: string): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE repo = ? AND issue_number = ? AND id != ?
         AND status NOT IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repo, issueNumber, excludeRunId) as RawRunRow | undefined
    return row ? this.mapRow(row) : null
  }

  /**
   * Count how many of the most recent finished runs for an issue are
   * consecutive blocks. Stops counting at the first non-blocked run.
   * Used as a circuit breaker to avoid infinite retry loops.
   */
  countConsecutiveBlocks(repo: string, issueNumber: number): number {
    const rows = this.db
      .prepare(
        `SELECT status FROM runs
         WHERE repo = ? AND issue_number = ?
         AND status NOT IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(repo, issueNumber) as Array<{ status: string }>
    let count = 0
    for (const row of rows) {
      if (row.status === 'blocked') count++
      else break
    }
    return count
  }

  getActive(): RunRecord[] {
    const rows = this.db
      .prepare(
        `WITH ranked_runs AS (
           SELECT
             r.*,
             ROW_NUMBER() OVER (
               PARTITION BY r.repo, r.issue_number
               ORDER BY
                 COALESCE(julianday(r.created_at), 0) DESC,
                 COALESCE(julianday(r.updated_at), 0) DESC,
                 r.rowid DESC,
                 r.id DESC
             ) AS run_rank
           FROM runs r
         )
         SELECT *
         FROM ranked_runs
         WHERE run_rank = 1
           AND status IN ('queued', 'running', 'blocked', 'review_ready', 'error')
         ORDER BY COALESCE(julianday(created_at), 0)`,
      )
      .all() as RawRunRow[]
    return rows.map((r) => this.mapRow(r))
  }

  countActiveForRepo(repo: string): number {
    const row = this.db
      .prepare(
        `WITH ranked_runs AS (
           SELECT
             r.repo,
             r.issue_number,
             r.status,
             ROW_NUMBER() OVER (
               PARTITION BY r.repo, r.issue_number
               ORDER BY
                 COALESCE(julianday(r.created_at), 0) DESC,
                 COALESCE(julianday(r.updated_at), 0) DESC,
                 r.rowid DESC,
                 r.id DESC
             ) AS run_rank
           FROM runs r
           WHERE r.repo = ?
         )
         SELECT COUNT(*) AS count
         FROM ranked_runs
         WHERE run_rank = 1
           AND status IN ('queued', 'running', 'blocked', 'review_ready', 'error')`,
      )
      .get(repo) as { count: number }
    return row.count
  }

  getSubRuns(parentRunId: string): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at')
      .all(parentRunId) as RawRunRow[]
    return rows.map((r) => this.mapRow(r))
  }

  private mapRow(row: RawRunRow): RunRecord {
    return {
      id: row.id,
      repo: row.repo,
      issueNumber: row.issue_number,
      issueTitle: row.issue_title ?? null,
      issueNodeId: row.issue_node_id ?? null,
      status: row.status as RunStatus,
      planner: row.planner ?? '',
      coder: row.coder ?? '',
      reviewer: row.reviewer ?? '',
      iterationCount: row.iteration_count ?? 0,
      currentPhase: row.current_phase,
      phaseData: safeParsePhaseData(row.phase_data, row.id),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastError: row.last_error,
      prNumber: row.pr_number,
      prTitle: row.pr_title ?? null,
      branchName: row.branch_name,
      branchSlug: row.branch_slug,
      worktreePath: row.worktree_path,
      estimatedCostUsd: row.estimated_cost_usd ?? 0,
      promptTokens: row.prompt_tokens ?? 0,
      completionTokens: row.completion_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      blockReason: row.block_reason ?? null,
      operationIntent: coerceOperationIntent(row.operation_intent),
      manualState: coerceManualState(row.manual_state),
      controlPayload: safeParseRecordJson(row.control_payload, row.id, 'control_payload'),
      parentRunId: row.parent_run_id ?? null,
      retryCount: row.retry_count ?? 0,
    }
  }
}

/**
 * Defensively parse the `phase_data` JSON blob on a run row. A single
 * corrupt row must not take down status, run-detail, list-runs, or TUI
 * reads — we degrade to null + warn so callers see the row in its
 * "no checkpoint data" shape.
 */
function safeParsePhaseData(raw: string | null, runId: string): Record<string, unknown> | null {
  return safeParseRecordJson(raw, runId, 'phase_data')
}

function safeParseRecordJson(
  raw: string | null,
  runId: string,
  fieldName: 'phase_data' | 'control_payload',
): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch (err) {
    logger.warn({ runId, fieldName, err }, 'Failed to parse run JSON payload — returning null')
    return null
  }
}

function coerceOperationIntent(value: string | null | undefined): RunOperationIntent {
  return value === 'continue' || value === 'retry' || value === 'rebase' || value === 'refresh'
    ? value
    : 'auto'
}

function coerceManualState(value: string | null | undefined): RunManualState {
  return value === 'awaiting_rebase_resolution' ? value : 'none'
}

interface RawRunRow {
  id: string
  repo: string
  issue_number: number
  issue_title: string | null
  issue_node_id: string | null
  status: string
  planner: string | null
  coder: string | null
  reviewer: string | null
  iteration_count: number | null
  current_phase: string | null
  phase_data: string | null
  started_at: string | null
  ended_at: string | null
  last_error: string | null
  pr_number: number | null
  pr_title: string | null
  branch_name: string | null
  branch_slug: string | null
  worktree_path: string | null
  estimated_cost_usd: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cache_read_tokens: number | null
  block_reason: string | null
  operation_intent: string | null
  manual_state: string | null
  control_payload: string | null
  parent_run_id: string | null
  retry_count: number | null
}

/**
 * Single source of truth for projecting a `RunState` (the unified domain
 * type from `loop/state.ts`) onto the legacy `(status, block_reason)`
 * column pair on the `runs` table.
 *
 * The mapping intentionally collapses several `RunState.kind` values
 * onto the same legacy status — `running` and `publishing` both project
 * to `'running'` because the existing schema doesn't distinguish "engine
 * actively working" from "PR posted, awaiting merge". R1c will wire
 * call sites through this helper; until then it's a standalone utility
 * with its own unit tests so the projection rules are pinned down.
 */
export function serializeState(state: RunState): {
  status: RunStatus
  blockReason: string | null
} {
  switch (state.kind) {
    case 'running':
      return { status: 'running', blockReason: null }
    case 'publishing':
      return { status: 'running', blockReason: null }
    case 'published':
      return { status: 'completed', blockReason: null }
    case 'blocked':
      return {
        status: 'blocked',
        blockReason: blockedReasonToLegacy(state.reason),
      }
    case 'error':
      return { status: 'error', blockReason: null }
    default:
      return assertNever(state, 'serializeState')
  }
}

/**
 * Inverse of `serializeState`: best-effort lift of a stored
 * `(status, block_reason)` row into a `RunState`. Fields that the
 * legacy schema can't carry — cost amounts, iteration counters,
 * adapter ids — default to zero/empty placeholders. Callers that need
 * accurate structured data should source it from the live engine
 * decision rather than rehydrating from disk.
 *
 * Returns `null` for unknown statuses so callers can decide whether
 * to treat the row as corrupt or fall back to a default.
 */
export function hydrateState(row: {
  status: string
  blockReason: string | null
}): RunState | null {
  switch (row.status) {
    case 'queued':
    case 'running':
      return { kind: 'running', phase: 'running' }
    case 'review_ready':
      return { kind: 'publishing' }
    case 'completed':
      return { kind: 'published', prUrl: '' }
    case 'error':
      return { kind: 'error', message: '', cause: 'fatal' }
    case 'blocked': {
      const legacy = row.blockReason
      if (!legacy || !LEGACY_BLOCK_REASONS.has(legacy)) {
        return blocked({ type: 'ambiguousReview', excerpt: legacy ?? 'unknown' })
      }
      const reason = blockedReasonFromLegacy(legacy as LegacyBlockReason)
      return blocked(reason)
    }
    default:
      return null
  }
}

type LegacyBlockReason =
  | 'cost_limit'
  | 'iteration_limit'
  | 'run_token_limit'
  | 'issue_token_limit'
  | 'daily_token_limit'
  | 'run_wall_clock_limit'
  | 'stuck_loop'
  | 'agent_pass_limit'
  | 'reviewer_blocked'
  | 'ambiguous_review'
  | 'verify_config'
  | 'merge_conflict'
  | 'auth_failure'
  | 'empty_diff'

const LEGACY_BLOCK_REASONS: ReadonlySet<string> = new Set<LegacyBlockReason>([
  'cost_limit',
  'iteration_limit',
  'run_token_limit',
  'issue_token_limit',
  'daily_token_limit',
  'run_wall_clock_limit',
  'stuck_loop',
  'agent_pass_limit',
  'reviewer_blocked',
  'ambiguous_review',
  'verify_config',
  'merge_conflict',
  'auth_failure',
  'empty_diff',
])

// Re-export for callers that need the typed reason without importing
// from `../loop/state.js` directly.
export type { BlockedReason }
