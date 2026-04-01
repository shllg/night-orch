import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildGitEnv, runGit } from '../../src/git/process.js'
import { execa } from 'execa'

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
}))

const mockExeca = vi.mocked(execa)

describe('git process helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('buildGitEnv whitelists safe variables only', () => {
    process.env['GITHUB_TOKEN'] = 'secret-token'
    process.env['PATH'] = '/usr/bin'
    process.env['LANG'] = 'en_US.UTF-8'

    const env = buildGitEnv()

    expect(env['PATH']).toBe('/usr/bin')
    expect(env['LANG']).toBe('en_US.UTF-8')
    expect(env['GITHUB_TOKEN']).toBeUndefined()
  })

  it('runGit forces extendEnv=false and uses sanitized env', async () => {
    await runGit(['status', '--porcelain'], { cwd: '/tmp/repo', env: { LC_ALL: 'C' } })

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain'],
      expect.objectContaining({
        cwd: '/tmp/repo',
        extendEnv: false,
        env: expect.objectContaining({ LC_ALL: 'C' }),
      }),
    )
  })
})
