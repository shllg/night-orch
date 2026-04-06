import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

vi.mock('../../src/utils/project-root.js', () => ({
  resolveProjectRoot: () => '/fake/project/root',
}))

describe('detectInstallMethod', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('returns "git" when .git directory exists at project root', async () => {
    mockExistsSync.mockReturnValue(true)

    const { detectInstallMethod } = await import('../../src/utils/install-method.js')
    expect(detectInstallMethod()).toBe('git')
    expect(mockExistsSync).toHaveBeenCalledWith('/fake/project/root/.git')
  })

  it('returns "npm" when project root is inside node_modules', async () => {
    mockExistsSync.mockReturnValue(false)

    vi.doMock('../../src/utils/project-root.js', () => ({
      resolveProjectRoot: () => '/usr/lib/node_modules/night-orch',
    }))

    const { detectInstallMethod } = await import('../../src/utils/install-method.js')
    expect(detectInstallMethod()).toBe('npm')
  })

  it('returns "unknown" when neither git nor node_modules detected', async () => {
    mockExistsSync.mockReturnValue(false)

    vi.doMock('../../src/utils/project-root.js', () => ({
      resolveProjectRoot: () => '/opt/custom/night-orch',
    }))

    const { detectInstallMethod } = await import('../../src/utils/install-method.js')
    expect(detectInstallMethod()).toBe('unknown')
  })
})
