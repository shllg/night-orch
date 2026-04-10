import { describe, it, expect } from 'vitest'
import {
  WorkerAuthError,
  WorkerError,
  WorkerParseError,
  WorkerRateLimitError,
  WorkerTimeoutError,
  WorkerTokenCaptureError,
  WorkerTransientError,
  isTransientWorkerError,
  isWorkerError,
} from '../../src/workers/errors.js'

describe('WorkerError hierarchy', () => {
  describe('WorkerAuthError', () => {
    it('carries the legacy adapterType/remediation/detail fields', () => {
      const err = new WorkerAuthError(
        'claude',
        're-auth via `claude login`',
        'exit 2 (no credentials)',
      )
      expect(err).toBeInstanceOf(WorkerError)
      expect(err.adapterType).toBe('claude')
      expect(err.remediation).toBe('re-auth via `claude login`')
      expect(err.detail).toBe('exit 2 (no credentials)')
      expect(err.code).toBe('WORKER_AUTH_FAILURE')
      expect(err.name).toBe('WorkerAuthError')
      expect(err.message).toContain('claude worker authentication failure')
    })

    it('defaults step to "unknown" for legacy call sites', () => {
      const err = new WorkerAuthError('codex', 'login', 'exit 1')
      expect(err.step).toBe('unknown')
    })

    it('accepts explicit step from R2+ call sites', () => {
      const err = new WorkerAuthError('codex', 'login', 'exit 1', 'coder')
      expect(err.step).toBe('coder')
    })
  })

  describe('WorkerTimeoutError', () => {
    it('exposes adapter/step/timeoutMs', () => {
      const err = new WorkerTimeoutError('claude', 'planner', 120000)
      expect(err.adapter).toBe('claude')
      expect(err.step).toBe('planner')
      expect(err.timeoutMs).toBe(120000)
      expect(err.code).toBe('WORKER_TIMEOUT')
      expect(err.message).toContain('timed out during planner after 120000ms')
    })
  })

  describe('WorkerParseError', () => {
    it('records the raw-output hash without the raw content', () => {
      const err = new WorkerParseError('codex', 'reviewer', 'sha256:abcd', 'no JSON found')
      expect(err.rawOutputHash).toBe('sha256:abcd')
      expect(err.code).toBe('WORKER_PARSE_FAILURE')
      expect(err.message).toContain('(sha256:abcd)')
      expect(err.message).toContain('no JSON found')
    })
  })

  describe('WorkerTokenCaptureError', () => {
    it('flags adapters that produced output but no token usage', () => {
      const err = new WorkerTokenCaptureError('claude', 'coder', 'sha256:f00')
      expect(err.rawOutputHash).toBe('sha256:f00')
      expect(err.code).toBe('WORKER_TOKEN_CAPTURE_FAILURE')
      expect(err.message).toContain('without parseable token usage')
    })
  })

  describe('WorkerRateLimitError', () => {
    it('carries optional retryAfterMs', () => {
      const withRetry = new WorkerRateLimitError('claude', 'planner', 'quota exceeded', 30000)
      expect(withRetry.retryAfterMs).toBe(30000)

      const withoutRetry = new WorkerRateLimitError('codex', 'coder', 'quota exceeded')
      expect(withoutRetry.retryAfterMs).toBeUndefined()
    })
  })

  describe('WorkerTransientError', () => {
    it('is the only class that triggers poller auto-retry', () => {
      const transient = new WorkerTransientError('claude', 'coder', 'connection dropped')
      const auth = new WorkerAuthError('claude', 'login', 'exit 2')
      const timeout = new WorkerTimeoutError('codex', 'coder', 60000)

      expect(isTransientWorkerError(transient)).toBe(true)
      expect(isTransientWorkerError(auth)).toBe(false)
      expect(isTransientWorkerError(timeout)).toBe(false)
    })
  })

  describe('isWorkerError', () => {
    it('narrows every subclass', () => {
      expect(isWorkerError(new WorkerAuthError('c', 'r', 'd'))).toBe(true)
      expect(isWorkerError(new WorkerTimeoutError('c', 's', 1))).toBe(true)
      expect(isWorkerError(new WorkerParseError('c', 's', 'h', 'd'))).toBe(true)
      expect(isWorkerError(new WorkerTokenCaptureError('c', 's', 'h'))).toBe(true)
      expect(isWorkerError(new WorkerRateLimitError('c', 's', 'd'))).toBe(true)
      expect(isWorkerError(new WorkerTransientError('c', 's', 'd'))).toBe(true)
    })

    it('rejects plain errors and non-error values', () => {
      expect(isWorkerError(new Error('plain'))).toBe(false)
      expect(isWorkerError('string')).toBe(false)
      expect(isWorkerError(null)).toBe(false)
      expect(isWorkerError(undefined)).toBe(false)
      expect(isWorkerError({})).toBe(false)
    })
  })

  describe('all subclasses inherit WorkerError', () => {
    const subclasses = [
      new WorkerAuthError('claude', 'login', 'exit 2'),
      new WorkerTimeoutError('claude', 'coder', 30000),
      new WorkerParseError('claude', 'reviewer', 'h', 'd'),
      new WorkerTokenCaptureError('claude', 'coder', 'h'),
      new WorkerRateLimitError('claude', 'planner', 'd'),
      new WorkerTransientError('claude', 'coder', 'd'),
    ]

    it.each(subclasses)('%s extends WorkerError', (err) => {
      expect(err).toBeInstanceOf(WorkerError)
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toMatch(/^WORKER_/)
    })

    it('each carries adapter and step context', () => {
      for (const err of subclasses) {
        expect(typeof err.adapter).toBe('string')
        expect(typeof err.step).toBe('string')
      }
    })
  })
})
