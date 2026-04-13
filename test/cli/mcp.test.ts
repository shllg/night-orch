import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockLoadConfig,
  mockResolveConfigPath,
  mockInitDatabase,
  mockResolveConfigWithRuntimeSettings,
  mockCreateForgeAdapter,
  mockCreateMetricsService,
  mockStartMCPStdio,
  mockLogger,
  mockMcpLogger,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockResolveConfigPath: vi.fn().mockReturnValue('/tmp/config.yml'),
  mockInitDatabase: vi.fn(),
  mockResolveConfigWithRuntimeSettings: vi.fn(),
  mockCreateForgeAdapter: vi.fn(),
  mockCreateMetricsService: vi.fn(),
  mockStartMCPStdio: vi.fn().mockResolvedValue(undefined),
  mockLogger: { level: 'info' as string },
  mockMcpLogger: { info: vi.fn(), warn: vi.fn() },
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

vi.mock('../../src/settings/runtime.js', () => ({
  resolveConfigWithRuntimeSettings: (...args: unknown[]) => mockResolveConfigWithRuntimeSettings(...args),
}))

vi.mock('../../src/forge/factory.js', () => ({
  createForgeAdapter: (...args: unknown[]) => mockCreateForgeAdapter(...args),
}))

vi.mock('../../src/metrics/service.js', () => ({
  createMetricsService: (...args: unknown[]) => mockCreateMetricsService(...args),
}))

vi.mock('../../src/mcp/server.js', () => ({
  startMCPStdio: (...args: unknown[]) => mockStartMCPStdio(...args),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: mockLogger,
  createLogger: vi.fn(() => mockMcpLogger),
}))

import { mcpCommand } from '../../src/cli/commands/mcp.js'

function makeConfig() {
  return {
    storage: { dbPath: '/tmp/night-orch-test.db' },
    repos: [{ repo: 'org/repo' }],
    metrics: { enabled: true, host: '127.0.0.1', port: 9090 },
  }
}

describe('mcpCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLogger.level = 'info'

    const baseConfig = makeConfig()
    mockLoadConfig.mockReturnValue(baseConfig)
    mockResolveConfigWithRuntimeSettings.mockReturnValue(baseConfig)
    mockInitDatabase.mockReturnValue({})
    mockCreateForgeAdapter.mockReturnValue({})
  })

  it('does not crash when metrics bind fails with EADDRINUSE', async () => {
    const err = Object.assign(new Error('Address in use'), { code: 'EADDRINUSE' })
    mockCreateMetricsService.mockReturnValue({
      start: vi.fn().mockRejectedValue(err),
      endpoint: { host: '127.0.0.1', port: 9090 },
    })

    await expect(mcpCommand()).resolves.toBeUndefined()

    expect(mockLogger.level).toBe('silent')
    expect(mockStartMCPStdio).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: null }),
    )
    expect(mockMcpLogger.info).toHaveBeenCalledWith(
      "Metrics bind failed — if 'night-orch run' is already running, this is expected (run owns :9090).",
    )
  })
})
