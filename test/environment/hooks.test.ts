import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { execa } from 'execa'
import { runRunHooks } from '../../src/environment/hooks.js'
import type { RunTokens } from '../../src/environment/tokens.js'

const mockExeca = vi.mocked(execa)
const tokens: RunTokens = { issue: 1, run: 'r1', port: 5400, project: 'proj-1-r1' }

describe('runRunHooks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('substitutes tokens and runs hooks in order', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runRunHooks('/wt', [['docker', 'compose', '-p', '{project}', 'up']], tokens, 'fail-fast')

    expect(mockExeca).toHaveBeenCalledWith('docker', ['compose', '-p', 'proj-1-r1', 'up'], expect.any(Object))
  })

  it('fail-fast: throws when a hook exits non-zero', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' } as never)

    await expect(runRunHooks('/wt', [['docker', 'up']], tokens, 'fail-fast')).rejects.toThrow()
  })

  it('attempt-all: runs every hook even when one fails and never throws', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'down1 failed' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

    await expect(
      runRunHooks('/wt', [['docker', 'down'], ['rm', 'db']], tokens, 'attempt-all'),
    ).resolves.toBeUndefined()

    expect(mockExeca).toHaveBeenCalledWith('docker', ['down'], expect.any(Object))
    expect(mockExeca).toHaveBeenCalledWith('rm', ['db'], expect.any(Object))
  })

  it('applies failure hints to the thrown message on fail-fast', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'role "app_user" does not exist' } as never)

    await expect(
      runRunHooks(
        '/wt',
        [{ command: ['bundle', 'db:prepare'], failureHints: [{ contains: 'app_user', message: 'Create the role.' }] }],
        tokens,
        'fail-fast',
      ),
    ).rejects.toThrow('Create the role.')
  })
})
