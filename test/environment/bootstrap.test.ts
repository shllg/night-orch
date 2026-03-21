import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runBootstrapCommands, type BootstrapCommand } from '../../src/environment/bootstrap.js'

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}))

// Suppress logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { execa } from 'execa'

const mockExeca = vi.mocked(execa)

describe('runBootstrapCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs commands sequentially', async () => {
    const callOrder: string[] = []
    mockExeca.mockImplementation(((binary: string) => {
      callOrder.push(binary)
      return Promise.resolve({ exitCode: 0 })
    }) as never)

    const commands: BootstrapCommand[] = [
      { command: 'pnpm install', when: 'always' },
      { command: 'pnpm db:migrate', when: 'always' },
    ]

    await runBootstrapCommands('/tmp/wt', commands, 'shared')

    expect(callOrder).toEqual(['pnpm', 'pnpm'])
    expect(mockExeca).toHaveBeenCalledTimes(2)
  })

  it('passes correct args to execa', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    const commands: BootstrapCommand[] = [
      { command: 'pnpm install --frozen-lockfile', when: 'always' },
    ]

    await runBootstrapCommands('/tmp/wt', commands, 'shared')

    expect(mockExeca).toHaveBeenCalledWith(
      'pnpm',
      ['install', '--frozen-lockfile'],
      { cwd: '/tmp/wt', timeout: 300_000, reject: false },
    )
  })

  it('filters commands by mode — runs "always" and matching mode', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    const commands: BootstrapCommand[] = [
      { command: 'echo always', when: 'always' },
      { command: 'echo shared-only', when: 'shared' },
      { command: 'echo dedicated-only', when: 'dedicated' },
    ]

    await runBootstrapCommands('/tmp/wt', commands, 'shared')

    expect(mockExeca).toHaveBeenCalledTimes(2)
    expect(mockExeca).toHaveBeenCalledWith('echo', ['always'], expect.any(Object))
    expect(mockExeca).toHaveBeenCalledWith('echo', ['shared-only'], expect.any(Object))
  })

  it('filters commands by mode — dedicated mode', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    const commands: BootstrapCommand[] = [
      { command: 'echo always', when: 'always' },
      { command: 'echo shared-only', when: 'shared' },
      { command: 'echo dedicated-only', when: 'dedicated' },
    ]

    await runBootstrapCommands('/tmp/wt', commands, 'dedicated')

    expect(mockExeca).toHaveBeenCalledTimes(2)
    expect(mockExeca).toHaveBeenCalledWith('echo', ['always'], expect.any(Object))
    expect(mockExeca).toHaveBeenCalledWith('echo', ['dedicated-only'], expect.any(Object))
  })

  it('throws on non-zero exit code (fail fast)', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never) // first succeeds
      .mockResolvedValueOnce({ exitCode: 1, stderr: 'Error: something broke' } as never) // second fails

    const commands: BootstrapCommand[] = [
      { command: 'pnpm install', when: 'always' },
      { command: 'pnpm db:migrate', when: 'always' },
      { command: 'pnpm seed', when: 'always' },
    ]

    await expect(runBootstrapCommands('/tmp/wt', commands, 'shared')).rejects.toThrow(
      /Bootstrap command failed: pnpm db:migrate/,
    )

    // Third command should not have been called (fail fast)
    expect(mockExeca).toHaveBeenCalledTimes(2)
  })

  it('handles empty command list', async () => {
    await expect(runBootstrapCommands('/tmp/wt', [], 'shared')).resolves.toBeUndefined()
    expect(mockExeca).not.toHaveBeenCalled()
  })

  it('includes exit code and stderr in error message', async () => {
    mockExeca.mockResolvedValue({ exitCode: 127, stderr: 'command not found' } as never)

    const commands: BootstrapCommand[] = [
      { command: 'nonexistent-cmd', when: 'always' },
    ]

    await expect(runBootstrapCommands('/tmp/wt', commands, 'shared')).rejects.toThrow(
      /Exit code: 127/,
    )
  })
})
