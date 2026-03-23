import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockLoadConfig = vi.fn()
const mockResolveConfigPath = vi.fn().mockReturnValue('/tmp/config.yml')
const mockExecFile = vi.fn()

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  resolveConfigPath: (...args: unknown[]) => mockResolveConfigPath(...args),
  ConfigError: class ConfigError extends Error {
    details?: string[]
  },
}))

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

import { labelsInitCommand } from '../../src/cli/commands/labels-init.js'

const BASE_CONFIG = {
  github: {
    apiBaseUrl: 'https://api.github.com',
  },
  repos: [
    {
      repo: 'org/repo',
      forge: 'github',
      labels: {
        ready: ['orch:ready'],
        running: 'orch:running',
        blocked: ['orch:blocked', 'orch:needs-human'],
        reviewReady: 'orch:review-ready',
        error: 'orch:error',
        retry: 'orch:retry',
      },
      labelConfig: {},
    },
  ],
}

describe('labelsInitCommand', () => {
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    mockLoadConfig.mockReturnValue(BASE_CONFIG)
    mockExecFile.mockImplementation((file, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb
      callback?.(null, '', '')
      return {} as unknown
    })
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  it('errors when a targeted repo is not in config', async () => {
    await labelsInitCommand('org/missing')
    expect(process.exitCode).toBe(1)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Repository not found in config: org/missing'))
  })

  it('prints dry-run gh commands without executing gh', async () => {
    await labelsInitCommand('org/repo', { dryRun: true })
    expect(process.exitCode).not.toBe(1)
    expect(mockExecFile).not.toHaveBeenCalled()
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run] gh label create orch:ready'))
  })

  it('executes gh label create in non-dry-run mode', async () => {
    await labelsInitCommand('org/repo', { dryRun: false })
    expect(process.exitCode).not.toBe(1)
    expect(mockExecFile).toHaveBeenCalled()
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['label', 'create', 'orch:ready', '--repo', 'org/repo', '--force']),
      { timeout: 20_000 },
      expect.any(Function),
    )
  })
})
