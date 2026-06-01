import { describe, expect, it } from 'vitest'
import { workerErrorToBlockedReason } from '../../src/loop/worker-errors.js'
import {
  WorkerAuthError,
  WorkerParseError,
  WorkerRateLimitError,
  WorkerTimeoutError,
  WorkerTokenCaptureError,
  WorkerTransientError,
} from '../../src/workers/errors.js'

describe('workerErrorToBlockedReason', () => {
  it('maps deterministic worker failures to durable blocked reasons', () => {
    expect(
      workerErrorToBlockedReason(new WorkerAuthError('claude', 'run `claude login`', 'signed out')),
    ).toEqual({ type: 'authFailure', adapter: 'claude' })

    expect(
      workerErrorToBlockedReason(new WorkerTimeoutError('codex', 'coder', 120_000)),
    ).toEqual({ type: 'workerTimeout', adapter: 'codex', step: 'coder', timeoutMs: 120_000 })

    expect(
      workerErrorToBlockedReason(new WorkerTokenCaptureError('claude', 'reviewer', 'sha256:abc')),
    ).toEqual({ type: 'tokenCaptureFailed', adapter: 'claude', step: 'reviewer' })

    expect(
      workerErrorToBlockedReason(new WorkerParseError('codex', 'planner', 'sha256:def', 'missing JSON')),
    ).toEqual({
      type: 'ambiguousReview',
      excerpt: 'codex output parse failure during planner (sha256:def): missing JSON',
    })

    expect(
      workerErrorToBlockedReason(new WorkerRateLimitError('claude', 'coder', 'quota exhausted')),
    ).toEqual({
      type: 'ambiguousReview',
      excerpt: 'claude rate-limited during coder: quota exhausted',
    })
  })

  it('rejects transient worker failures so poller retry can handle them', () => {
    expect(() => {
      workerErrorToBlockedReason(new WorkerTransientError('claude', 'coder', 'connection reset'))
    }).toThrow('workerErrorToBlockedReason called with transient error')
  })
})
