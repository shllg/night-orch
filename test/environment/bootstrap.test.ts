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
import { logger } from '../../src/utils/logger.js'

const mockExeca = vi.mocked(execa)
const mockLoggerError = vi.mocked(logger.error)

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

  it('supports command arrays without shell splitting', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stderr: '' } as never)
    const commands: BootstrapCommand[] = [
      { command: ['node', '-e', 'console.log("ok")'], when: 'always' },
    ]
    await runBootstrapCommands('/tmp/wt', commands, 'shared')
    expect(mockExeca).toHaveBeenCalledWith(
      'node',
      ['-e', 'console.log("ok")'],
      expect.any(Object),
    )
  })

  it('includes exit code, stdout and stderr in error message when both streams are present', async () => {
    mockExeca.mockResolvedValue({
      exitCode: 127,
      stdout: 'psql: command not found',
      stderr: 'bin/rails aborted!',
    } as never)

    const commands: BootstrapCommand[] = [
      { command: 'bundle exec rails db:prepare', when: 'always' },
    ]

    await expect(runBootstrapCommands('/tmp/wt', commands, 'shared')).rejects.toThrow(
      /Exit code: 127[\s\S]*stdout:[\s\S]*psql: command not found[\s\S]*stderr:[\s\S]*bin\/rails aborted!/,
    )
  })

  it('adds a configured failure hint when output contains a matching pattern', async () => {
    mockExeca.mockResolvedValue({
      exitCode: 1,
      stdout: 'psql:/tmp/wt/db/structure.sql:1688: ERROR:  role "app_user" does not exist',
      stderr: 'bin/rails aborted!',
    } as never)

    const commands: BootstrapCommand[] = [
      {
        command: 'bundle exec rails db:prepare',
        when: 'always',
        failureHints: [{
          contains: 'role "app_user" does not exist',
          message: 'Create PostgreSQL role "app_user" before running bootstrap.',
          output: 'combined',
        }],
      },
    ]

    await expect(runBootstrapCommands('/tmp/wt', commands, 'shared')).rejects.toThrow(
      /hint:[\s\S]*Create PostgreSQL role "app_user" before running bootstrap/i,
    )
  })

  it('does not include configured failure hints when patterns do not match output', async () => {
    mockExeca.mockResolvedValue({
      exitCode: 1,
      stdout: 'generic failure output',
      stderr: 'bin/rails aborted!',
    } as never)

    const commands: BootstrapCommand[] = [
      {
        command: 'bundle exec rails db:prepare',
        when: 'always',
        failureHints: [{
          contains: 'role "app_user" does not exist',
          message: 'Create PostgreSQL role "app_user" before running bootstrap.',
          output: 'combined',
        }],
      },
    ]

    let caught: Error | null = null
    try {
      await runBootstrapCommands('/tmp/wt', commands, 'shared')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect(caught?.message).not.toContain('hint:')
  })

  it('omits the stderr section when stderr is empty', async () => {
    mockExeca.mockResolvedValue({
      exitCode: 1,
      stdout: 'some diagnostic',
      stderr: '',
    } as never)

    const commands: BootstrapCommand[] = [
      { command: 'rake build', when: 'always' },
    ]

    let caught: Error | null = null
    try {
      await runBootstrapCommands('/tmp/wt', commands, 'shared')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect(caught?.message).toContain('stdout:')
    expect(caught?.message).toContain('some diagnostic')
    expect(caught?.message).not.toContain('stderr:')
  })

  it('omits the stdout section when stdout is empty', async () => {
    mockExeca.mockResolvedValue({
      exitCode: 2,
      stdout: '',
      stderr: 'boom',
    } as never)

    const commands: BootstrapCommand[] = [
      { command: 'rake test', when: 'always' },
    ]

    let caught: Error | null = null
    try {
      await runBootstrapCommands('/tmp/wt', commands, 'shared')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect(caught?.message).toContain('stderr:')
    expect(caught?.message).toContain('boom')
    expect(caught?.message).not.toContain('stdout:')
  })

  it('truncates stdout tail longer than 4000 characters and keeps the last 4000 chars', async () => {
    const longStdout = 'x'.repeat(10000)
    mockExeca.mockResolvedValue({
      exitCode: 1,
      stdout: longStdout,
      stderr: '',
    } as never)

    const commands: BootstrapCommand[] = [
      { command: 'bundle install', when: 'always' },
    ]

    let caught: Error | null = null
    try {
      await runBootstrapCommands('/tmp/wt', commands, 'shared')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect(caught?.message).toContain('... (truncated, 6000 chars omitted)')
    expect(caught?.message.endsWith('x'.repeat(4000))).toBe(true)
  })

  it('logs full untruncated stdout and stderr on failure', async () => {
    const longStdout = 'a'.repeat(10000)
    const stderr = 'stderr line'
    mockExeca.mockResolvedValue({
      exitCode: 3,
      stdout: longStdout,
      stderr,
    } as never)

    const commands: BootstrapCommand[] = [
      { command: 'noisy-command', when: 'always' },
    ]

    await expect(runBootstrapCommands('/tmp/wt', commands, 'shared')).rejects.toThrow(
      /Bootstrap command failed/,
    )

    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    const loggedFields = mockLoggerError.mock.calls[0]?.[0] as {
      command: string
      exitCode: number
      stdout: string
      stderr: string
    }
    expect(loggedFields.command).toBe('noisy-command')
    expect(loggedFields.exitCode).toBe(3)
    expect(loggedFields.stdout).toBe(longStdout)
    expect(loggedFields.stderr).toBe(stderr)
  })
})
