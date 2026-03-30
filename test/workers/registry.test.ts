import { describe, it, expect, vi } from 'vitest'
import { WorkerAdapterRegistry } from '../../src/workers/registry.js'
import type { WorkerAdapter, WorkerProfileInput } from '../../src/workers/types.js'

function makeMockAdapter(): WorkerAdapter {
  return {
    runTask: vi.fn().mockResolvedValue({
      rawOutput: '', exitCode: 0, timedOut: false, durationMs: 0,
      parsed: null, parseError: null, sessionId: null,
    }),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
  }
}

describe('WorkerAdapterRegistry', () => {
  it('creates adapter for registered type', () => {
    const registry = new WorkerAdapterRegistry()
    const adapter = makeMockAdapter()
    registry.register('test', () => adapter)
    const profile = { type: 'test', command: 'test', args: [], workerTimeoutSeconds: 60, minimalEnv: true, runtimeWrapper: null, env: {} } as WorkerProfileInput
    expect(registry.create(profile)).toBe(adapter)
  })

  it('throws for unregistered type', () => {
    const registry = new WorkerAdapterRegistry()
    const profile = { type: 'unknown', command: 'x', args: [], workerTimeoutSeconds: 60, minimalEnv: true, runtimeWrapper: null, env: {} } as WorkerProfileInput
    expect(() => registry.create(profile)).toThrow('No adapter registered for worker type "unknown"')
  })

  it('lists registered types', () => {
    const registry = new WorkerAdapterRegistry()
    registry.register('claude', () => makeMockAdapter())
    registry.register('codex', () => makeMockAdapter())
    expect(registry.getRegisteredTypes()).toEqual(['claude', 'codex'])
  })

  it('prevents duplicate registration', () => {
    const registry = new WorkerAdapterRegistry()
    registry.register('claude', () => makeMockAdapter())
    expect(() => registry.register('claude', () => makeMockAdapter())).toThrow('already registered')
  })
})
