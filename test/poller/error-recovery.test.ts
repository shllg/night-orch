import { describe, it, expect } from 'vitest'
import { classifyInfraError, type InfraErrorContext } from '../../src/poller/error-recovery.js'
import {
  WorkerAuthError,
  WorkerTimeoutError,
  WorkerTokenCaptureError,
  WorkerTransientError,
} from '../../src/workers/errors.js'

/**
 * R6: focused unit tests for the pure `classifyInfraError` helper.
 *
 * The executor side (`applyRecoveryPlan`) is already exercised
 * end-to-end through the existing poller integration tests in
 * `test/poller/poller.test.ts`. These tests target the decision
 * logic only so a regression of the classifier lights up
 * immediately without needing the full poller fixture stack.
 */
describe('classifyInfraError', () => {
  function makeCtx(overrides: Partial<InfraErrorContext> = {}): InfraErrorContext {
    return {
      runId: 'run-abc',
      currentRetryCount: 0,
      err: new Error('generic infra failure'),
      maxAutoRetries: 3,
      ...overrides,
    }
  }

  describe('infra errors (plain Error, git failures, forge hiccups)', () => {
    it('returns auto_retry on first failure when retry budget is available', () => {
      const plan = classifyInfraError(makeCtx())
      expect(plan.kind).toBe('auto_retry')
      if (plan.kind === 'auto_retry') {
        expect(plan.attemptCount).toBe(1)
        expect(plan.errorMessage).toBe('generic infra failure')
      }
    })

    it('returns auto_retry with the correct attempt count when retries have already been made', () => {
      const plan = classifyInfraError(makeCtx({ currentRetryCount: 1 }))
      expect(plan.kind).toBe('auto_retry')
      if (plan.kind === 'auto_retry') expect(plan.attemptCount).toBe(2)
    })

    it('returns mark_error when the retry budget is exhausted', () => {
      const plan = classifyInfraError(makeCtx({ currentRetryCount: 3, maxAutoRetries: 3 }))
      expect(plan.kind).toBe('mark_error')
      if (plan.kind === 'mark_error') {
        expect(plan.attemptCount).toBe(4)
        expect(plan.errorMessage).toBe('generic infra failure')
      }
    })

    it('returns mark_error when maxAutoRetries is zero (no retries allowed)', () => {
      const plan = classifyInfraError(makeCtx({ currentRetryCount: 0, maxAutoRetries: 0 }))
      expect(plan.kind).toBe('mark_error')
      if (plan.kind === 'mark_error') expect(plan.attemptCount).toBe(1)
    })

    it('extracts the error message from a non-Error thrown value', () => {
      const plan = classifyInfraError(makeCtx({ err: 'string thrown' }))
      expect(plan.errorMessage).toContain('string thrown')
    })
  })

  describe('typed WorkerErrors', () => {
    it('returns abort_no_auto_retry for WorkerAuthError (engine catch should have intercepted)', () => {
      const err = new WorkerAuthError('claude', 'run `claude login`', 'exit 2')
      const plan = classifyInfraError(makeCtx({ err }))
      expect(plan.kind).toBe('abort_no_auto_retry')
      if (plan.kind === 'abort_no_auto_retry') {
        expect(plan.errorMessage).toContain('claude worker authentication failure')
      }
    })

    it('returns abort_no_auto_retry for WorkerTimeoutError', () => {
      const err = new WorkerTimeoutError('codex', 'coder', 60000)
      const plan = classifyInfraError(makeCtx({ err }))
      expect(plan.kind).toBe('abort_no_auto_retry')
    })

    it('returns abort_no_auto_retry for WorkerTokenCaptureError', () => {
      const err = new WorkerTokenCaptureError('claude', 'planner', 'sha256:abcd')
      const plan = classifyInfraError(makeCtx({ err }))
      expect(plan.kind).toBe('abort_no_auto_retry')
    })

    it('treats WorkerTransientError like a plain infra error and allows retry', () => {
      const err = new WorkerTransientError('claude', 'coder', 'connection dropped')
      const plan = classifyInfraError(makeCtx({ err }))
      expect(plan.kind).toBe('auto_retry')
      if (plan.kind === 'auto_retry') expect(plan.attemptCount).toBe(1)
    })

    it('respects the retry budget for WorkerTransientError', () => {
      const err = new WorkerTransientError('claude', 'coder', 'connection dropped')
      const plan = classifyInfraError(makeCtx({ err, currentRetryCount: 3, maxAutoRetries: 3 }))
      expect(plan.kind).toBe('mark_error')
    })
  })
})
