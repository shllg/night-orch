import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecFileSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}))

vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

describe('getBuildInfo', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete process.env.NIGHT_ORCH_GIT_SHA
  })

  it('prefers NIGHT_ORCH_GIT_SHA over git command output', async () => {
    process.env.NIGHT_ORCH_GIT_SHA = 'ABCDEF1234567'
    mockReadFileSync.mockReturnValueOnce('{"version":"2.3.4"}')

    const { getBuildInfo } = await import('../../src/utils/build-info.js')
    expect(getBuildInfo()).toEqual({
      version: '2.3.4',
      gitSha: 'abcdef1234567',
    })
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('falls back to git rev-parse when env SHA is invalid', async () => {
    process.env.NIGHT_ORCH_GIT_SHA = 'not-a-sha'
    mockReadFileSync.mockReturnValueOnce('{"version":"3.0.0"}')
    mockExecFileSync.mockReturnValueOnce('1234567890ABCDEF\n')

    const { getBuildInfo } = await import('../../src/utils/build-info.js')
    expect(getBuildInfo()).toEqual({
      version: '3.0.0',
      gitSha: '1234567890abcdef',
    })
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
  })

  it('uses safe fallbacks when package or git metadata is unavailable', async () => {
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error('missing package')
    })
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('git unavailable')
    })

    const { getBuildInfo } = await import('../../src/utils/build-info.js')
    expect(getBuildInfo()).toEqual({
      version: '0.1.0',
      gitSha: null,
    })
  })

  it('rejects invalid git outputs', async () => {
    mockReadFileSync.mockReturnValueOnce('{"version":"1.0.0"}')
    mockExecFileSync.mockReturnValueOnce('definitely-not-a-sha')

    const { getBuildInfo } = await import('../../src/utils/build-info.js')
    expect(getBuildInfo()).toEqual({
      version: '1.0.0',
      gitSha: null,
    })
  })
})
