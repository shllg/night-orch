/**
 * Base class for all typed worker errors. The loop engine catches any
 * `WorkerError` that is NOT a `WorkerTransientError` and converts it to
 * a typed `BlockedState`; transient errors bubble to the poller for
 * infra auto-retry. Pre-R2 the engine only caught `WorkerAuthError` and
 * every other worker failure was treated as a transient infra error —
 * which meant worker timeouts, parse failures, and token-capture
 * failures all triggered expensive full-run retries that were almost
 * guaranteed to fail the same way.
 *
 * Subclasses carry the `adapter` and `step` context so the engine can
 * construct a precise `BlockedReason` without re-guessing the surrounding
 * state. Use `isWorkerError(err)` for the catch-side check rather than
 * `instanceof` chains.
 */
import type { TokenUsage } from './types.js'

/**
 * Token-usage + pricing context captured at the moment a worker call
 * failed. Carried on the thrown `WorkerError` so the loop engine can
 * record the spend for the failed attempt before blocking or retrying —
 * without this, a worker that burned tokens and then failed was recorded
 * at $0, making expensive failures look free (issue #341).
 */
export interface WorkerErrorCost {
  tokenUsage?: TokenUsage
  pricingIdentity: {
    role: string
    workerType: string
    pricingModel: string | null
    fallbackMinuteUsd?: number | null
  }
  durationMs: number
}

export abstract class WorkerError extends Error {
  abstract readonly code: string

  /**
   * Set by the step executor when the failing worker call reported token
   * usage. The engine reads it to record cost on the failure path.
   */
  cost?: WorkerErrorCost

  constructor(
    public readonly adapter: string,
    public readonly step: string,
    message: string,
  ) {
    super(message)
    this.name = this.constructor.name
  }

  /** Attach failure-time cost context; returns `this` for fluent throws. */
  withCost(cost: WorkerErrorCost): this {
    this.cost = cost
    return this
  }
}

/**
 * Thrown when a worker process exits due to an authentication/signed-out
 * condition. The loop engine converts this to a typed `authFailure`
 * blocked state with a clear remediation hint instead of retrying
 * futilely.
 *
 * Preserves the pre-R2 public API (`adapterType`, `remediation`,
 * `detail`) so existing log-statements keep working. New code should
 * prefer the inherited `adapter`/`step` fields for consistency with
 * the other error subclasses.
 */
export class WorkerAuthError extends WorkerError {
  readonly code = 'WORKER_AUTH_FAILURE' as const

  constructor(
    public readonly adapterType: string,
    public readonly remediation: string,
    public readonly detail: string,
    step = 'unknown',
  ) {
    super(adapterType, step, `${adapterType} worker authentication failure: ${detail}`)
  }
}

/**
 * Thrown when a worker process fails to complete within its configured
 * timeout. The engine blocks the attempt with `workerTimeout` reason
 * rather than bubbling to the poller — retrying the same timed-out
 * worker with the same input is almost always pointless.
 */
export class WorkerTimeoutError extends WorkerError {
  readonly code = 'WORKER_TIMEOUT' as const

  constructor(
    adapter: string,
    step: string,
    public readonly timeoutMs: number,
  ) {
    super(adapter, step, `${adapter} worker timed out during ${step} after ${timeoutMs}ms`)
  }
}

/**
 * Thrown when a worker produces output that cannot be parsed into
 * structured fields. Distinct from `WorkerTokenCaptureError` because
 * parse failures may indicate a transient model hiccup whereas token
 * capture failures always indicate a schema/adapter bug.
 *
 * `rawOutputHash` is a short digest of the raw output included in the
 * error message — do NOT store the raw content itself to avoid leaking
 * prompt contents into logs.
 */
export class WorkerParseError extends WorkerError {
  readonly code = 'WORKER_PARSE_FAILURE' as const

  constructor(
    adapter: string,
    step: string,
    public readonly rawOutputHash: string,
    detail: string,
  ) {
    super(adapter, step, `${adapter} output parse failure during ${step} (${rawOutputHash}): ${detail}`)
  }
}

/**
 * Thrown when a worker returned an otherwise-valid response but the
 * adapter could not extract token-usage metadata. This is the error
 * that R4a will use to kill the silent duration-based cost fallback:
 * instead of pricing the run by wall-clock time (which undercounts
 * 10-100×), the engine blocks the attempt so the operator can inspect
 * the worker output and file a bug.
 */
export class WorkerTokenCaptureError extends WorkerError {
  readonly code = 'WORKER_TOKEN_CAPTURE_FAILURE' as const

  constructor(
    adapter: string,
    step: string,
    public readonly rawOutputHash: string,
  ) {
    super(
      adapter,
      step,
      `${adapter} produced ${step} output without parseable token usage (${rawOutputHash})`,
    )
  }
}

/**
 * Thrown when the remote model provider signals a rate limit. The
 * `retryAfterMs` field, when present, hints at a safe wait duration.
 * The engine currently blocks attempts on rate limit (operator can
 * retry with `/orch retry` later); a future R6 ErrorRecovery module
 * may downgrade this to a transient error with backoff.
 */
export class WorkerRateLimitError extends WorkerError {
  readonly code = 'WORKER_RATE_LIMIT' as const

  constructor(
    adapter: string,
    step: string,
    detail: string,
    public readonly retryAfterMs?: number,
  ) {
    super(adapter, step, `${adapter} rate-limited during ${step}: ${detail}`)
  }
}

/**
 * Thrown when a worker completed but its output shows the execution
 * environment rejected all writes — e.g. a Codex coder running in a
 * read-only sandbox where every `apply_patch` is refused. Distinct from
 * `WorkerTransientError` because retrying an unwritable environment is
 * guaranteed to fail the same way; the engine converts this to a typed
 * `environmentFault` blocked state instead of burning the empty-diff retry
 * budget (issue #341).
 *
 * `detail` is a short, non-sensitive excerpt of the rejection signature —
 * never the full worker output, to avoid leaking prompt contents into logs.
 */
export class WorkerEnvironmentError extends WorkerError {
  readonly code = 'WORKER_ENVIRONMENT_FAULT' as const

  constructor(
    adapter: string,
    step: string,
    public readonly detail: string,
  ) {
    super(adapter, step, `${adapter} worker environment fault during ${step}: ${detail}`)
  }
}

/**
 * Thrown when the worker failure looks genuinely transient — network
 * blip, dropped connection, flaky CLI startup. This is the **only**
 * `WorkerError` subclass that the engine re-throws so the poller's
 * auto-retry path can take over. Everything else becomes a typed
 * `BlockedState` and stays put until the operator acts on it.
 */
export class WorkerTransientError extends WorkerError {
  readonly code = 'WORKER_TRANSIENT_FAILURE' as const

  constructor(
    adapter: string,
    step: string,
    detail: string,
  ) {
    super(adapter, step, `${adapter} transient failure during ${step}: ${detail}`)
  }
}

/** Narrowing helper for catch blocks. */
export function isWorkerError(err: unknown): err is WorkerError {
  return err instanceof WorkerError
}

/**
 * Returns true if this error should bubble to the poller for auto-retry
 * rather than being converted to a terminal blocked state. Today only
 * `WorkerTransientError` qualifies; kept as a function so R6 can widen
 * the set (e.g. rate-limit + short retryAfter window) without touching
 * every call site.
 */
export function isTransientWorkerError(err: unknown): err is WorkerTransientError {
  return err instanceof WorkerTransientError
}
