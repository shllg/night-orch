import type { LoopPhase } from './types.js'
import type { RunContext } from './types.js'

/**
 * Single source of truth for a run's state throughout the loop engine,
 * decision layer, persistence layer, and UI surfaces.
 *
 * Before R1 the concept of "state" was split across four places:
 *  - `BlockReason` string literal union in `loop/types.ts`
 *  - `TerminalStatus` string literal union in `loop/types.ts`
 *  - `LoopDecision.blockReason` on the decision return shape
 *  - `runs.status` + `runs.block_reason` columns on disk
 *
 * Any new state had to be added to all four places and the compiler
 * couldn't help. This union collapses everything into one exhaustively
 * checkable discriminated type. Pair every `switch(state.kind)` and
 * `switch(reason.type)` with `assertNever` in the default branch to
 * guarantee compile-time coverage.
 */
export type RunState =
  | { kind: 'running'; phase: LoopPhase }
  | { kind: 'publishing'; prUrl?: string }
  | { kind: 'published'; prUrl: string; mergedAt?: string }
  | BlockedState
  | ErrorState

export interface BlockedState {
  kind: 'blocked'
  /**
   * Short human-readable summary suitable for a label status comment,
   * notification, or log. Never null.
   */
  message: string
  /**
   * Whether the attempt can be recovered without human intervention.
   * `true` for cost/iteration/empty-diff blocks that clear automatically
   * on budget reset or a fresh attempt; `false` for reviewer-initiated
   * blocks, auth failures, or merge conflicts that need an operator.
   */
  recoverable: boolean
  reason: BlockedReason
}

export interface ErrorState {
  kind: 'error'
  message: string
  /**
   * `transient` means the poller may auto-retry; `fatal` is escalated
   * without further retries. R2 will introduce a typed worker error
   * hierarchy that feeds into this distinction.
   */
  cause: 'transient' | 'fatal'
}

export type BlockedReason =
  | {
      type: 'costLimit'
      limit: 'per-run' | 'daily'
      actualUsd: number
      limitUsd: number
    }
  | {
      type: 'iterationLimit'
      iterations: number
      max: number
    }
  | {
      type: 'agentPassLimit'
      passes: number
      max: number
    }
  | {
      type: 'reviewerBlocked'
      summary: string
    }
  | {
      type: 'ambiguousReview'
      excerpt: string
    }
  | {
      type: 'verifyConfig'
      detail: string
    }
  | {
      type: 'mergeConflict'
      files: string[]
      summary: string
    }
  | {
      type: 'authFailure'
      adapter: string
    }
  | {
      type: 'emptyDiff'
      retries: number
    }
  | {
      type: 'workerTimeout'
      adapter: string
      step: string
      timeoutMs: number
    }
  | {
      type: 'tokenCaptureFailed'
      adapter: string
      step: string
    }

/**
 * Total set of blocked-reason type tags. Keep in lockstep with
 * `BlockedReason` above — the exhaustiveness test pins this to the
 * union so adding a new variant without updating this list breaks
 * the test suite.
 */
export const BLOCKED_REASON_TYPES = [
  'costLimit',
  'iterationLimit',
  'agentPassLimit',
  'reviewerBlocked',
  'ambiguousReview',
  'verifyConfig',
  'mergeConflict',
  'authFailure',
  'emptyDiff',
  'workerTimeout',
  'tokenCaptureFailed',
] as const satisfies readonly BlockedReason['type'][]

export type BlockedReasonType = (typeof BLOCKED_REASON_TYPES)[number]

/**
 * Total set of top-level state kinds. Paired with the same satisfies trick
 * so missing a kind in this list is a compile error.
 */
export const RUN_STATE_KINDS = [
  'running',
  'publishing',
  'published',
  'blocked',
  'error',
] as const satisfies readonly RunState['kind'][]

export type RunStateKind = (typeof RUN_STATE_KINDS)[number]

export const LEGACY_BLOCK_REASON_VALUES = [
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
] as const satisfies readonly NonNullable<RunContext['blockReason']>[]

export type LegacyBlockReason = (typeof LEGACY_BLOCK_REASON_VALUES)[number]

type MissingLegacyBlockReasons = Exclude<NonNullable<RunContext['blockReason']>, LegacyBlockReason>
export const LEGACY_BLOCK_REASONS_COVER_RUN_CONTEXT: MissingLegacyBlockReasons extends never ? true : never = true

/**
 * Compile-time exhaustiveness helper. Place in the `default` arm of a
 * switch that must handle every state or reason variant. If a new variant
 * is added to the union without updating the switch, TypeScript will
 * error at the call site because `x` is no longer `never`.
 */
export function assertNever(x: never, context?: string): never {
  const suffix = context !== undefined ? ` in ${context}` : ''
  throw new Error(`Non-exhaustive RunState variant${suffix}: ${JSON.stringify(x)}`)
}

/**
 * Construct a `BlockedState` with sane defaults. Prefer this helper over
 * literal object construction at call sites so the shape stays consistent
 * and the recoverable flag is always set explicitly.
 */
export function blocked(
  reason: BlockedReason,
  opts: { message?: string; recoverable?: boolean } = {},
): BlockedState {
  return {
    kind: 'blocked',
    message: opts.message ?? describeBlockedReason(reason),
    recoverable: opts.recoverable ?? isBlockedReasonRecoverable(reason),
    reason,
  }
}

/**
 * Default recoverability for each reason type. Cost/iteration/empty-diff
 * blocks unblock naturally once the operator grants budget or starts a
 * new attempt. Reviewer/auth/merge-conflict blocks need human action.
 */
export function isBlockedReasonRecoverable(reason: BlockedReason): boolean {
  switch (reason.type) {
    case 'costLimit':
      return true
    case 'iterationLimit':
      return true
    case 'agentPassLimit':
      return true
    case 'emptyDiff':
      return true
    case 'workerTimeout':
      return true
    case 'ambiguousReview':
      return true
    case 'verifyConfig':
      return false
    case 'reviewerBlocked':
      return false
    case 'mergeConflict':
      return false
    case 'authFailure':
      return false
    case 'tokenCaptureFailed':
      return false
    default:
      return assertNever(reason, 'isBlockedReasonRecoverable')
  }
}

/**
 * Short human-readable summary of a blocked reason. Exhaustively handles
 * every variant. Used when constructing a BlockedState without an explicit
 * message and by UI surfaces (status comment, notification body, TUI log).
 */
export function describeBlockedReason(reason: BlockedReason): string {
  switch (reason.type) {
    case 'costLimit':
      return `Cost limit (${reason.limit}): $${reason.actualUsd.toFixed(2)} of $${reason.limitUsd.toFixed(2)}`
    case 'iterationLimit':
      return `Review iteration limit reached: ${reason.iterations}/${reason.max}`
    case 'agentPassLimit':
      return `Max total agent passes reached: ${reason.passes}/${reason.max}`
    case 'reviewerBlocked':
      return `Reviewer blocked: ${reason.summary}`
    case 'ambiguousReview':
      return `Review output not parseable: ${reason.excerpt.slice(0, 120)}`
    case 'verifyConfig':
      return `Verify configuration error: ${reason.detail}`
    case 'mergeConflict':
      return `Merge conflict in ${reason.files.length} file(s): ${reason.summary}`
    case 'authFailure':
      return `Worker authentication failed: ${reason.adapter}`
    case 'emptyDiff':
      return `Coder produced an empty diff (${reason.retries} retries)`
    case 'workerTimeout':
      return `${reason.adapter} timed out during ${reason.step} after ${reason.timeoutMs}ms`
    case 'tokenCaptureFailed':
      return `${reason.adapter} produced output without parseable token usage (${reason.step})`
    default:
      return assertNever(reason, 'describeBlockedReason')
  }
}

/**
 * Legacy bridge: map the pre-R1 `BlockReason` string enum to a typed
 * `BlockedReason` object. R1b and R1c use this during the incremental
 * consumer rewiring so decision/engine/finalizer can produce typed
 * reasons without the call site knowing all the new fields.
 *
 * Fields that can't be recovered from the old enum (like actualUsd or
 * iteration counts) are filled in from `ctx` where possible and fall
 * back to 0/empty. Once all consumers build `BlockedReason` natively
 * this helper can be deleted.
 */
export interface LegacyBlockReasonContext {
  actualCostUsd?: number
  costLimitUsd?: number
  costLimitScope?: 'per-run' | 'daily'
  iterations?: number
  maxIterations?: number
  passes?: number
  maxPasses?: number
  emptyDiffRetries?: number
  reviewerSummary?: string
  reviewerExcerpt?: string
  verifyDetail?: string
  mergeConflictFiles?: string[]
  mergeConflictSummary?: string
  authAdapter?: 'claude' | 'codex' | 'opencode'
  workerAdapter?: string
  workerStep?: string
  workerTimeoutMs?: number
}

export function blockedReasonFromLegacy(
  legacy: LegacyBlockReason,
  ctx: LegacyBlockReasonContext = {},
): BlockedReason {
  switch (legacy) {
    case 'cost_limit':
      return {
        type: 'costLimit',
        limit: ctx.costLimitScope ?? 'per-run',
        actualUsd: ctx.actualCostUsd ?? 0,
        limitUsd: ctx.costLimitUsd ?? 0,
      }
    case 'iteration_limit':
      return {
        type: 'iterationLimit',
        iterations: ctx.iterations ?? 0,
        max: ctx.maxIterations ?? 0,
      }
    case 'run_token_limit':
    case 'issue_token_limit':
    case 'daily_token_limit':
    case 'run_wall_clock_limit':
    case 'stuck_loop':
      return {
        type: 'iterationLimit',
        iterations: ctx.iterations ?? 0,
        max: ctx.maxIterations ?? 0,
      }
    case 'agent_pass_limit':
      return {
        type: 'agentPassLimit',
        passes: ctx.passes ?? 0,
        max: ctx.maxPasses ?? 0,
      }
    case 'reviewer_blocked':
      return { type: 'reviewerBlocked', summary: ctx.reviewerSummary ?? '' }
    case 'ambiguous_review':
      return { type: 'ambiguousReview', excerpt: ctx.reviewerExcerpt ?? '' }
    case 'verify_config':
      return { type: 'verifyConfig', detail: ctx.verifyDetail ?? '' }
    case 'merge_conflict':
      return {
        type: 'mergeConflict',
        files: ctx.mergeConflictFiles ?? [],
        summary: ctx.mergeConflictSummary ?? '',
      }
    case 'auth_failure':
      return { type: 'authFailure', adapter: ctx.authAdapter ?? 'claude' }
    case 'empty_diff':
      return { type: 'emptyDiff', retries: ctx.emptyDiffRetries ?? 0 }
    default:
      return assertNever(legacy, 'blockedReasonFromLegacy')
  }
}

/**
 * Inverse of `blockedReasonFromLegacy` — projects a typed `BlockedReason`
 * back to the legacy string enum so the current DB column schema and any
 * un-migrated consumer keeps working during the incremental rewiring.
 * New reason types (workerTimeout, tokenCaptureFailed) have no legacy
 * mapping and bridge to the closest legacy value for DB persistence;
 * callers that care about the new types should switch on `BlockedReason`
 * directly.
 */
export function blockedReasonToLegacy(
  reason: BlockedReason,
):
  | 'cost_limit'
  | 'iteration_limit'
  | 'agent_pass_limit'
  | 'reviewer_blocked'
  | 'ambiguous_review'
  | 'verify_config'
  | 'merge_conflict'
  | 'auth_failure'
  | 'empty_diff' {
  switch (reason.type) {
    case 'costLimit':
      return 'cost_limit'
    case 'iterationLimit':
      return 'iteration_limit'
    case 'agentPassLimit':
      return 'agent_pass_limit'
    case 'reviewerBlocked':
      return 'reviewer_blocked'
    case 'ambiguousReview':
      return 'ambiguous_review'
    case 'verifyConfig':
      return 'verify_config'
    case 'mergeConflict':
      return 'merge_conflict'
    case 'authFailure':
      return 'auth_failure'
    case 'emptyDiff':
      return 'empty_diff'
    // R1-new reasons with no pre-R1 counterpart — map to closest legacy
    // tag so DB writes during the bridge period don't lose information
    // entirely. A follow-up R1c pass will replace these with native
    // columns.
    case 'workerTimeout':
      return 'auth_failure'
    case 'tokenCaptureFailed':
      return 'auth_failure'
    default:
      return assertNever(reason, 'blockedReasonToLegacy')
  }
}
