import type Database from 'better-sqlite3'
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
