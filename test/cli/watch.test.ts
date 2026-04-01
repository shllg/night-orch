import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockLoadConfig,
  mockResolveConfigPath,
  mockInitDatabase,
  mockRender,
  mockReleaseAll,
  mockClose,
  mockLogger,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockResolveConfigPath: vi.fn().mockReturnValue('/tmp/config.yml'),
  mockInitDatabase: vi.fn(),
  mockRender: vi.fn(),
  mockReleaseAll: vi.fn(),
  mockClose: vi.fn(),
  mockLogger: { level: 'info' },
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

vi.mock('../../src/state/leases.js', () => ({
  LeaseManager: class LeaseManager {
    releaseAll(...args: unknown[]) {
      return mockReleaseAll(...args)
    }
  },
}))

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
}))

vi.mock('../../src/cli/tui/app.js', () => ({
  App: () => null,
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: mockLogger,
}))

import { runWatch } from '../../src/cli/commands/watch.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('runWatch', () => {
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

  beforeEach(() => {
    vi.clearAllMocks()
    mockLogger.level = 'info'
    mockInitDatabase.mockReturnValue({ close: mockClose })
    mockLoadConfig.mockReturnValue({
      storage: { dbPath: '/tmp/test.db' },
      github: { pollIntervalSeconds: 60 },
    })
  })

  afterEach(() => {
    stdoutSpy.mockClear()
  })

  it('silences logger while TUI is active and restores it on exit', async () => {
    const wait = deferred<void>()
    mockRender.mockReturnValue({ waitUntilExit: vi.fn(() => wait.promise) })

    const runPromise = runWatch()
    expect(mockLogger.level).toBe('silent')

    wait.resolve()
    await runPromise

    expect(mockLogger.level).toBe('info')
    expect(mockClose).toHaveBeenCalled()
    expect(mockReleaseAll).toHaveBeenCalledWith('poller')
  })

  it('restores logger level when waitUntilExit throws', async () => {
    mockRender.mockReturnValue({ waitUntilExit: vi.fn().mockRejectedValue(new Error('render failed')) })

    await expect(runWatch()).rejects.toThrow('render failed')

    expect(mockLogger.level).toBe('info')
    expect(mockClose).toHaveBeenCalled()
  })
})
