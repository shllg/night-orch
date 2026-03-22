import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockLoadConfig = vi.fn()
const mockResolveConfigPath = vi.fn().mockReturnValue('/tmp/config.yml')
const mockInitDatabase = vi.fn()
const mockPollOnce = vi.fn()

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

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { runOnceCommand } from '../../src/cli/commands/run-once.js'

describe('runOnceCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    mockLoadConfig.mockReturnValue({
      storage: { dbPath: '/tmp/state.db' },
    })
    mockInitDatabase.mockReturnValue({ close: vi.fn() })
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
})
