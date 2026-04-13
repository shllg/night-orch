import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockLoadConfig,
  mockResolveConfigPath,
  mockInitDatabase,
  mockResolveConfigWithRuntimeSettings,
  mockLogger,
  mockCheckWorkerAuth,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockResolveConfigPath: vi.fn().mockReturnValue('/tmp/config.yml'),
  mockInitDatabase: vi.fn(),
  mockResolveConfigWithRuntimeSettings: vi.fn(),
  mockLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockCheckWorkerAuth: vi.fn().mockResolvedValue({ authenticated: true }),
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

vi.mock('../../src/utils/logger.js', () => ({
  logger: mockLogger,
}))

vi.mock('../../src/forge/factory.js', () => ({
  createForgeAdapter: vi.fn(),
}))

vi.mock('../../src/workers/auth-check.js', () => ({
  checkWorkerAuth: (...args: unknown[]) => mockCheckWorkerAuth(...args),
}))

import { doctorCommand } from '../../src/cli/commands/doctor.js'

function makeConfig() {
  return {
    github: { tokenEnv: 'TEST_GITHUB_TOKEN' },
    notifications: { channels: [] },
    repos: [],
    workerProfiles: {},
    storage: {
      dbPath: '/tmp/night-orch-doctor-test.db',
      worktreeRoot: '/tmp/night-orch-worktrees',
    },
    metrics: { enabled: true, host: '0.0.0.0', port: 9090 },
    ai: {
      internal: {
        provider: null,
        model: null,
        apiKeyEnv: null,
        enable: {
          triage: false,
          reviewerParseFallback: false,
          prBody: false,
        },
      },
    },
  }
}

function response(payload: unknown, status = 200): Pick<Response, 'status' | 'json'> {
  return {
    status,
    json: async () => payload,
  }
}

async function runDoctorAndCaptureOutput(): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  let output = ''
  try {
    await doctorCommand()
    output = logSpy.mock.calls.flat().join('\n')
  } finally {
    logSpy.mockRestore()
  }
  return output
}

describe('doctorCommand metrics probe', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    process.env['TEST_GITHUB_TOKEN'] = 'token'

    const config = makeConfig()
    mockLoadConfig.mockReturnValue(config)
    mockResolveConfigWithRuntimeSettings.mockReturnValue(config)
    mockInitDatabase.mockReturnValue({ close: vi.fn() })

    globalThis.fetch = vi.fn().mockResolvedValue(response({ ready: true })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env['TEST_GITHUB_TOKEN']
  })

  it('rewrites 0.0.0.0 to 127.0.0.1 for the metrics probe', async () => {
    const output = await runDoctorAndCaptureOutput()
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/healthz',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(output).toContain('Metrics probe: ok — http://127.0.0.1:9090/healthz')
  })

  it('classifies ready=false as not-ready', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(response({ ready: false }) as never)
    const output = await runDoctorAndCaptureOutput()
    expect(output).toContain('Metrics probe: not-ready — http://127.0.0.1:9090/healthz reports ready=false')
  })

  it('classifies ECONNREFUSED as connection-refused', async () => {
    const err = new TypeError('fetch failed') as TypeError & { cause?: { code: string } }
    err.cause = { code: 'ECONNREFUSED' }
    vi.mocked(globalThis.fetch).mockRejectedValue(err)

    const output = await runDoctorAndCaptureOutput()
    expect(output).toContain('Metrics probe: connection-refused')
    expect(output).toContain("is `night-orch run` launched?")
  })

  it('classifies AbortError as timeout', async () => {
    const err = new Error('request aborted')
    err.name = 'AbortError'
    vi.mocked(globalThis.fetch).mockRejectedValue(err)

    const output = await runDoctorAndCaptureOutput()
    expect(output).toContain('Metrics probe: timeout')
  })

  it('classifies runtime-disabled metrics as optional disabled-runtime', async () => {
    const disabledConfig = {
      ...makeConfig(),
      metrics: { enabled: false, host: '0.0.0.0', port: 9090 },
    }
    mockResolveConfigWithRuntimeSettings.mockReturnValue(disabledConfig)

    const output = await runDoctorAndCaptureOutput()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(output).toContain('Metrics probe (optional): disabled-runtime — metrics.enabled is false at runtime')
  })
})
