import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockLoadConfig,
  mockResolveConfigPath,
  mockInitDatabase,
  mockPollOnce,
  mockReleaseAll,
  mockSyncReconcile,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockResolveConfigPath: vi.fn().mockReturnValue('/tmp/config.yml'),
  mockInitDatabase: vi.fn(),
  mockPollOnce: vi.fn(),
  mockReleaseAll: vi.fn(),
  mockSyncReconcile: vi.fn(),
}))

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  resolveConfigPath: (...args: unknown[]) => mockResolveConfigPath(...args),
  ConfigError: class ConfigError extends Error {
    details?: string[]
  },
}))

vi.mock('../../src/state/db.js', () => ({
  initDatabase: (...args: unknown[]) => mockInitDatabase(...args),
}))

vi.mock('../../src/runner/poller.js', () => ({
  pollOnce: (...args: unknown[]) => mockPollOnce(...args),
}))

vi.mock('../../src/state/leases.js', () => ({
  LeaseManager: class LeaseManager {
    releaseAll(...args: unknown[]) {
      return mockReleaseAll(...args)
    }
  },
}))

vi.mock('../../src/ops/sync.js', () => ({
  SyncEngine: class SyncEngine {
    reconcile(...args: unknown[]) {
      return mockSyncReconcile(...args)
    }
  },
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { runOnceCommand } from '../../src/cli/commands/run-once.js'

function parseNdjsonFromWriteCalls(
  calls: Array<Parameters<typeof process.stdout.write>>,
): Array<Record<string, unknown>> {
  return calls
    .map((call) => call[0])
    .filter((chunk): chunk is string => typeof chunk === 'string')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('runOnceCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    mockLoadConfig.mockReturnValue({
      storage: { dbPath: '/tmp/state.db' },
    })
    mockInitDatabase.mockReturnValue({ close: vi.fn() })
    mockReleaseAll.mockReturnValue(0)
    mockSyncReconcile.mockResolvedValue({ reconciledRuns: [], expiredLeases: 0, orphanedWorktrees: [], labelCorrections: [] })
  })

  it('sets exit code to 1 when poller reports errors', async () => {
    mockPollOnce.mockResolvedValue({ processed: 0, errors: 1 })

    await runOnceCommand()

    expect(process.exitCode).toBe(1)
  })

  it('keeps exit code clear when poller completes without errors', async () => {
    mockPollOnce.mockResolvedValue({ processed: 1, errors: 0 })

    await runOnceCommand()

    expect(process.exitCode).not.toBe(1)
  })

  it('runs startup recovery before polling', async () => {
    mockPollOnce.mockResolvedValue({ processed: 0, errors: 0 })

    await runOnceCommand()

    expect(mockReleaseAll).toHaveBeenCalledWith()
    expect(mockSyncReconcile).toHaveBeenCalledWith(false)
  })

  it('emits ndjson events when ndjson mode is enabled', async () => {
    mockPollOnce.mockResolvedValue({ processed: 3, errors: 1 })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await runOnceCommand({ ndjson: true })

    const events = parseNdjsonFromWriteCalls(stdoutSpy.mock.calls)
    expect(events.map((event) => event['event'])).toEqual([
      'poll_start',
      'poll_result',
    ])
    expect(events[0]).toMatchObject({
      event: 'poll_start',
      mode: 'run-once',
      dryRun: false,
    })
    expect(events[1]).toMatchObject({
      event: 'poll_result',
      mode: 'run-once',
      processed: 3,
      errors: 1,
    })
  })
})
