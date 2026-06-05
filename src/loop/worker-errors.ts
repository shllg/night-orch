import {
  WorkerAuthError,
  WorkerEnvironmentError,
  WorkerParseError,
  WorkerRateLimitError,
  WorkerTimeoutError,
  WorkerTokenCaptureError,
  WorkerTransientError,
} from '../workers/errors.js'
import type { WorkerError } from '../workers/errors.js'
import { assertNever, type BlockedReason } from './state.js'

/**
 * Map a non-transient `WorkerError` to the appropriate typed
 * `BlockedReason`. Exhaustive over the hierarchy: adding a new
 * `WorkerError` subclass without updating this switch is a compile
 * error on the `assertNever` default.
 */
export function workerErrorToBlockedReason(err: WorkerError): BlockedReason {
  if (err instanceof WorkerAuthError) {
    return { type: 'authFailure', adapter: err.adapterType }
  }
  if (err instanceof WorkerTimeoutError) {
    return {
      type: 'workerTimeout',
      adapter: err.adapter,
      step: err.step,
      timeoutMs: err.timeoutMs,
    }
  }
  if (err instanceof WorkerTokenCaptureError) {
    return { type: 'tokenCaptureFailed', adapter: err.adapter, step: err.step }
  }
  if (err instanceof WorkerEnvironmentError) {
    return { type: 'environmentFault', adapter: err.adapter, step: err.step, detail: err.detail }
  }
  if (err instanceof WorkerParseError) {
    return { type: 'ambiguousReview', excerpt: err.message }
  }
  if (err instanceof WorkerRateLimitError) {
    return { type: 'ambiguousReview', excerpt: err.message }
  }
  if (err instanceof WorkerTransientError) {
    throw new Error(`workerErrorToBlockedReason called with transient error: ${err.message}`)
  }
  return assertNever(err as never, 'workerErrorToBlockedReason')
}
