import type Database from 'better-sqlite3'
import { generateRunId } from '../utils/ids.js'
import { nowUtcIso } from '../utils/time.js'

/**
 * Intent that caused an attempt to be created. `initial` is the first
 * attempt for an issue; retry/continue/rebase/rediscover all INSERT a new
 * row linked to the previous attempt via `previous_attempt_id`.
 */
export type AttemptIntent = 'initial' | 'retry' | 'continue' | 'rebase' | 'rediscover'

export const ATTEMPT_INTENTS: readonly AttemptIntent[] = [
  'initial',
  'retry',
  'continue',
  'rebase',
  'rediscover',
] as const

/**
 * Raised when a caller attempts to mutate an attempt row whose
 * `terminated_at` is set. Terminal attempts are immutable; recovery from a
 * terminal state must create a new attempt via retry/continue/rebase.
 */
export class AttemptTerminatedError extends Error {
  readonly code = 'ATTEMPT_TERMINATED'
  constructor(public readonly attemptId: string) {
    super(`Attempt ${attemptId} is terminated and cannot be mutated`)
    this.name = 'AttemptTerminatedError'
  }
}

/**
 * Raised when a caller references an attempt id that does not exist. Kept
 * separate from AttemptTerminatedError so callers can distinguish "unknown"
 * from "frozen".
 */
export class AttemptNotFoundError extends Error {
  readonly code = 'ATTEMPT_NOT_FOUND'
  constructor(public readonly attemptId: string) {
    super(`Unknown attempt ${attemptId}`)
    this.name = 'AttemptNotFoundError'
  }
}

/**
 * Throws if the given attempt row does not exist or has `terminated_at` set.
 * Call this at the start of any write path that mutates an existing attempt
 * row to enforce the "terminal attempts are frozen" invariant.
 */
export function assertMutable(db: Database.Database, attemptId: string): void {
  const row = db
    .prepare('SELECT terminated_at FROM runs WHERE id = ?')
    .get(attemptId) as { terminated_at: string | null } | undefined
  if (!row) {
    throw new AttemptNotFoundError(attemptId)
  }
  if (row.terminated_at !== null) {
    throw new AttemptTerminatedError(attemptId)
  }
}

export interface FinalizeAttemptInput {
  attemptId: string
  /** ISO timestamp; defaults to now. Injectable for deterministic tests. */
  at?: string
}

/**
 * Marks an attempt as terminated by setting `terminated_at`. This is the
 * only legitimate path that sets the column; all other writers must route
 * their "this attempt is done" transitions through here. Calling this on an
 * already-terminated attempt throws AttemptTerminatedError.
 */
export function finalizeAttempt(db: Database.Database, input: FinalizeAttemptInput): void {
  const at = input.at ?? nowUtcIso()
  const tx = db.transaction(() => {
    assertMutable(db, input.attemptId)
    db.prepare('UPDATE runs SET terminated_at = ?, updated_at = ? WHERE id = ?').run(
      at,
      at,
      input.attemptId,
    )
  })
  tx()
}

export interface AttemptChainEntry {
  id: string
  previousAttemptId: string | null
  parentRunId: string | null
  sequenceNumber: number
  intent: AttemptIntent
  status: string
  terminatedAt: string | null
  createdAt: string
}

/**
 * Returns every top-level attempt for a `(repo, issueNumber)` pair ordered
 * by sequence number ascending. Sub-runs (rows with a non-null
 * `parent_run_id`, representing decomposition children) are excluded — each
 * sub-run has its own independent attempt chain keyed by its parent.
 */
export function getAttemptChain(
  db: Database.Database,
  repo: string,
  issueNumber: number,
): AttemptChainEntry[] {
  const rows = db
    .prepare(
      `SELECT id, previous_attempt_id, parent_run_id, sequence_number, intent,
              status, terminated_at, created_at
       FROM runs
       WHERE repo = ? AND issue_number = ? AND parent_run_id IS NULL
       ORDER BY sequence_number ASC, created_at ASC`,
    )
    .all(repo, issueNumber) as Array<{
    id: string
    previous_attempt_id: string | null
    parent_run_id: string | null
    sequence_number: number
    intent: string
    status: string
    terminated_at: string | null
    created_at: string
  }>

  return rows.map((r) => ({
    id: r.id,
    previousAttemptId: r.previous_attempt_id,
    parentRunId: r.parent_run_id,
    sequenceNumber: r.sequence_number,
    intent: r.intent as AttemptIntent,
    status: r.status,
    terminatedAt: r.terminated_at,
    createdAt: r.created_at,
  }))
}

/**
 * Returns the head attempt (highest sequence_number) in a chain for a given
 * issue, or null if no attempts exist. The head is the only attempt that
 * should ever be in a non-terminal state for a given chain.
 */
export function getHeadAttempt(
  db: Database.Database,
  repo: string,
  issueNumber: number,
): AttemptChainEntry | null {
  const chain = getAttemptChain(db, repo, issueNumber)
  return chain.length > 0 ? chain[chain.length - 1]! : null
}

export type FollowupIntent = Exclude<AttemptIntent, 'initial'>

export interface CreateFollowupAttemptInput {
  /** ID of the attempt being superseded. Must be non-terminated. */
  previousAttemptId: string
  /** Reason this new attempt is being created. */
  intent: FollowupIntent
  /**
   * When true, branch-related fields (branch_name, branch_slug,
   * worktree_path, pr_number, pr_title) are cleared on the new attempt so
   * the poller starts a fresh checkout from the base branch. Defaults:
   *  - retry: true  (retry starts from base branch)
   *  - continue: false (continue reuses the prior branch + PR)
   *  - rebase: false (rebase reuses the prior branch)
   *  - rediscover: true (treated like a fresh discovery pass)
   */
  resetBranch?: boolean
  /** phaseData to seed on the new attempt. Pass null to write SQL NULL. */
  phaseData: Record<string, unknown> | null
  /** controlPayload to seed on the new attempt. Pass null to write SQL NULL. */
  controlPayload: Record<string, unknown> | null
  /** Optional override timestamp for deterministic tests. */
  now?: string
}

export interface CreateFollowupAttemptResult {
  attemptId: string
  sequenceNumber: number
}

interface PreviousAttemptSnapshot {
  id: string
  repo: string
  issue_number: number
  issue_node_id: string | null
  issue_title: string | null
  planner: string
  coder: string
  reviewer: string
  parent_run_id: string | null
  branch_name: string | null
  branch_slug: string | null
  worktree_path: string | null
  pr_number: number | null
  pr_title: string | null
  sequence_number: number
  terminated_at: string | null
}

function defaultResetBranch(intent: FollowupIntent): boolean {
  switch (intent) {
    case 'retry':
    case 'rediscover':
      return true
    case 'continue':
    case 'rebase':
      return false
  }
}

/**
 * Finalize `previousAttemptId` and INSERT a new attempt row linked to it.
 *
 * This is the **only** supported path for retry/continue/rebase. It
 * eliminates the previous mutable-row pattern that reset cost accumulators,
 * overwrote block_reason, and rewound iteration counters on the same row —
 * each of which produced a distinct FIX commit in the project history.
 *
 * The insert preserves identity (repo, issue, role assignments, parent
 * sub-run id) and, when `resetBranch === false`, also the branch/PR
 * pointers. Cost columns start at zero. sequence_number = previous + 1.
 */
export function createFollowupAttempt(
  db: Database.Database,
  input: CreateFollowupAttemptInput,
): CreateFollowupAttemptResult {
  const now = input.now ?? nowUtcIso()
  const resetBranch = input.resetBranch ?? defaultResetBranch(input.intent)

  const tx = db.transaction((): CreateFollowupAttemptResult => {
    const prev = db
      .prepare(
        `SELECT id, repo, issue_number, issue_node_id, issue_title,
                planner, coder, reviewer, parent_run_id,
                branch_name, branch_slug, worktree_path, pr_number, pr_title,
                sequence_number, terminated_at
         FROM runs WHERE id = ?`,
      )
      .get(input.previousAttemptId) as PreviousAttemptSnapshot | undefined

    if (!prev) {
      throw new AttemptNotFoundError(input.previousAttemptId)
    }
    if (prev.terminated_at !== null) {
      throw new AttemptTerminatedError(input.previousAttemptId)
    }

    db.prepare('UPDATE runs SET terminated_at = ?, updated_at = ? WHERE id = ?').run(
      now,
      now,
      prev.id,
    )

    const newId = generateRunId()
    const newSequence = prev.sequence_number + 1

    db.prepare(
      `INSERT INTO runs (
         id, repo, issue_number, issue_node_id, issue_title, status,
         planner, coder, reviewer,
         iteration_count, current_phase, phase_data,
         started_at, ended_at, last_error,
         pr_number, pr_title, branch_name, branch_slug, worktree_path,
         estimated_cost_usd, prompt_tokens, completion_tokens, cache_read_tokens,
         block_reason, operation_intent, manual_state, control_payload,
         parent_run_id, retry_count,
         previous_attempt_id, sequence_number, intent, terminated_at,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, 'queued',
         ?, ?, ?,
         0, NULL, ?,
         NULL, NULL, NULL,
         ?, ?, ?, ?, ?,
         0, 0, 0, 0,
         NULL, ?, 'none', ?,
         ?, 0,
         ?, ?, ?, NULL,
         ?, ?
       )`,
    ).run(
      newId,
      prev.repo,
      prev.issue_number,
      prev.issue_node_id,
      prev.issue_title,
      prev.planner,
      prev.coder,
      prev.reviewer,
      input.phaseData === null ? null : JSON.stringify(input.phaseData),
      resetBranch ? null : prev.pr_number,
      resetBranch ? null : prev.pr_title,
      resetBranch ? null : prev.branch_name,
      resetBranch ? null : prev.branch_slug,
      resetBranch ? null : prev.worktree_path,
      input.intent,
      input.controlPayload === null ? null : JSON.stringify(input.controlPayload),
      prev.parent_run_id,
      prev.id,
      newSequence,
      input.intent,
      now,
      now,
    )

    return { attemptId: newId, sequenceNumber: newSequence }
  })

  return tx()
}
