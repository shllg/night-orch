import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockLoadConfig,
  mockResolveConfigPath,
  mockInitDatabase,
  mockPollOnce,
  mockReleaseAll,
  mockSyncReconcile,
  mockResolveConfigWithRuntimeSettings,
  mockMaybeRun,
  mockWaitForNextCycle,
  shutdownState,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockResolveConfigPath: vi.fn().mockReturnValue('/tmp/config.yml'),
  mockInitDatabase: vi.fn(),
  mockPollOnce: vi.fn(),
  mockReleaseAll: vi.fn(),
  mockSyncReconcile: vi.fn(),
  mockResolveConfigWithRuntimeSettings: vi.fn(),
  mockMaybeRun: vi.fn(),
  mockWaitForNextCycle: vi.fn(),
  shutdownState: {
    instances: [] as Array<{ isShuttingDown: boolean }>,
  },
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

vi.mock('../../src/ops/auto-cleanup.js', () => ({
  AutoCleanupScheduler: class AutoCleanupScheduler {
    maybeRun(...args: unknown[]) {
      return mockMaybeRun(...args)
    }
  },
}))

vi.mock('../../src/poller/shutdown.js', () => ({
  ShutdownHandler: class ShutdownHandler {
    isShuttingDown = false

    constructor() {
      shutdownState.instances.push(this)
    }

    register(): void {}
    trackRun(): void {}
  },
}))

vi.mock('../../src/poller/control.js', () => ({
  PollCycleController: class PollCycleController {
    triggerPollCycle() {
      return { state: 'queued-next-cycle' as const }
    }

    waitForNextCycle(...args: unknown[]) {
      return mockWaitForNextCycle(...args)
    }
  },
  resolveExternalPollTriggerPath: vi.fn().mockReturnValue('/tmp/night-orch.poll'),
}))

vi.mock('../../src/settings/runtime.js', () => ({
  resolveConfigWithRuntimeSettings: (...args: unknown[]) => mockResolveConfigWithRuntimeSettings(...args),
}))

vi.mock('../../src/metrics/service.js', () => ({
  createMetricsService: vi.fn(),
}))

vi.mock('../../src/forge/factory.js', () => ({
  createForgeAdapter: vi.fn(),
}))

vi.mock('../../src/mcp/http.js', () => ({
  startMCPHttpServer: vi.fn(),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { runCommand } from '../../src/cli/commands/run.js'

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

describe('runCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    shutdownState.instances.length = 0
    process.exitCode = undefined
    const config = {
      storage: { dbPath: '/tmp/state.db' },
      github: { pollIntervalSeconds: 30 },
      repos: [],
      metrics: undefined,
      mcp: { enabled: false, httpHost: '127.0.0.1', httpPort: 7401 },
    }
    mockLoadConfig.mockReturnValue(config)
    mockResolveConfigWithRuntimeSettings.mockImplementation((baseConfig: unknown) => baseConfig)
    mockInitDatabase.mockReturnValue({})
    mockReleaseAll.mockReturnValue(0)
    mockSyncReconcile.mockResolvedValue({ reconciledRuns: [], expiredLeases: 0, orphanedWorktrees: [], labelCorrections: [] })
    mockPollOnce.mockResolvedValue({ processed: 2, errors: 0, immediateFollowupRepos: [] })
    mockMaybeRun.mockResolvedValue(undefined)
    mockWaitForNextCycle.mockImplementation(async () => {
      for (const instance of shutdownState.instances) {
        instance.isShuttingDown = true
      }
      return 'timer'
    })
  })

  it('emits ndjson events for a poll cycle when ndjson mode is enabled', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await runCommand({ ndjson: true })

    const events = parseNdjsonFromWriteCalls(stdoutSpy.mock.calls)
    expect(events.map((event) => event['event'])).toEqual([
      'poll_cycle_start',
      'poll_cycle_result',
    ])
    expect(events[0]).toMatchObject({
      event: 'poll_cycle_start',
      mode: 'run',
      dryRun: false,
    })
    expect(events[1]).toMatchObject({
      event: 'poll_cycle_result',
      mode: 'run',
      dryRun: false,
      processed: 2,
      errors: 0,
    })
  })
})
