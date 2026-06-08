import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runVerifyCommands, allVerifyPassed } from '../../src/loop/verifier.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

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
const mockLoggerWarn = vi.mocked(logger.warn)

describe('runVerifyCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns passing results for all successful commands', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' } as never)

    const results = await runVerifyCommands('/tmp/wt', ['pnpm test', 'pnpm lint'])

    expect(results).toHaveLength(2)
    expect(results[0]!.passed).toBe(true)
    expect(results[1]!.passed).toBe(true)
    expect(results[0]!.command).toBe('pnpm test')
    expect(results[1]!.command).toBe('pnpm lint')
  })

  it('returns failing result when a command fails', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' } as never)
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'FAIL' } as never)

    const results = await runVerifyCommands('/tmp/wt', ['pnpm test', 'pnpm lint'])

    expect(results).toHaveLength(2)
    expect(results[0]!.passed).toBe(true)
    expect(results[1]!.passed).toBe(false)
    expect(results[1]!.exitCode).toBe(1)
    expect(results[1]!.stderr).toBe('FAIL')
  })

  it('continues running all commands even after failure', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'fail1' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' } as never)

    const results = await runVerifyCommands('/tmp/wt', ['cmd1', 'cmd2'])

    expect(results).toHaveLength(2)
    expect(results[0]!.passed).toBe(false)
    expect(results[1]!.passed).toBe(true)
  })

  it('handles command throwing (e.g., timeout)', async () => {
    mockExeca.mockRejectedValue(new Error('Command timed out'))

    const results = await runVerifyCommands('/tmp/wt', ['slow-cmd'])

    expect(results).toHaveLength(1)
    expect(results[0]!.passed).toBe(false)
    expect(results[0]!.exitCode).toBe(1)
    expect(results[0]!.stderr).toContain('Command timed out')
  })

  it('records a timed-out command as failed with exit 124, not a masked exit 0', async () => {
    // execa with `reject: false` returns exitCode undefined + timedOut on kill.
    mockExeca.mockResolvedValue({
      exitCode: undefined,
      timedOut: true,
      signal: 'SIGTERM',
      stdout: 'partial output',
      stderr: '',
    } as never)

    const results = await runVerifyCommands('/tmp/wt', [{ command: 'pnpm test', timeoutSeconds: 60 }])

    expect(results[0]!.passed).toBe(false)
    expect(results[0]!.exitCode).toBe(124) // never 0
    expect(results[0]!.stderr).toContain('timed out after 60s')
    expect(results[0]!.stderr).toContain('SIGTERM')
  })

  it('records a signal-killed command as failed exit 1 instead of exit 0', async () => {
    mockExeca.mockResolvedValue({
      exitCode: undefined,
      timedOut: false,
      signal: 'SIGKILL',
      stdout: '',
      stderr: 'oom',
    } as never)

    const results = await runVerifyCommands('/tmp/wt', ['pnpm test'])

    expect(results[0]!.passed).toBe(false)
    expect(results[0]!.exitCode).toBe(1)
  })

  it('records a missing verify command as exit 127 with a named diagnostic, not bare undefined', async () => {
    // execa reject:false resolves spawn errors with exitCode undefined + code.
    mockExeca.mockResolvedValue({ exitCode: undefined, code: 'ENOENT', timedOut: false, stdout: '', stderr: '' } as never)

    const results = await runVerifyCommands('/tmp/wt', ['bin/ci-test-setup'])

    expect(results[0]!.passed).toBe(false)
    expect(results[0]!.exitCode).toBe(127) // never undefined / masked 0
    expect(results[0]!.stderr).toContain('command not found in worktree: bin/ci-test-setup')
    expect(results[0]!.stderr).toContain('/tmp/wt/bin/ci-test-setup')
    expect(results[0]!.stderr).toContain('[ENOENT]')
  })

  it('records a non-executable verify command as exit 126 with EACCES', async () => {
    mockExeca.mockResolvedValue({ exitCode: undefined, code: 'EACCES', timedOut: false, stdout: '', stderr: '' } as never)

    const results = await runVerifyCommands('/tmp/wt', ['./run.sh'])

    expect(results[0]!.passed).toBe(false)
    expect(results[0]!.exitCode).toBe(126)
    expect(results[0]!.stderr).toContain('command not executable')
    expect(results[0]!.stderr).toContain('[EACCES]')
  })

  it('records a missing before-hook as a named diagnostic with exit 127 and skips the command', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: undefined, code: 'ENOENT', timedOut: false, stdout: '', stderr: '' } as never) // before hook missing
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never) // after hook

    const results = await runVerifyCommands('/tmp/wt', [
      { command: 'rails test', before: [['bin/db-setup']], after: [['docker', 'down']] },
    ])

    expect(results[0]!.passed).toBe(false)
    expect(results[0]!.exitCode).toBe(127)
    expect(results[0]!.stderr).toContain('command not found in worktree: bin/db-setup')
    expect(results[0]!.stderr).not.toContain('Exit code: undefined')
    // command itself must not have run; after still cleaned up
    expect(mockExeca).not.toHaveBeenCalledWith('rails', ['test'], expect.any(Object))
    expect(mockExeca).toHaveBeenCalledWith('docker', ['down'], expect.any(Object))
  })

  it('returns empty array for empty command list', async () => {
    const results = await runVerifyCommands('/tmp/wt', [])
    expect(results).toEqual([])
    expect(mockExeca).not.toHaveBeenCalled()
  })

  it('captures stderr even on success', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'pass', stderr: 'some warning' } as never)

    const results = await runVerifyCommands('/tmp/wt', ['cmd'])

    expect(results[0]!.passed).toBe(true)
    expect(results[0]!.stderr).toBe('some warning')
  })

  it('scrubs token-shaped stderr before logging failed verify commands', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: `GITHUB_TOKEN=${token}` } as never)

    const results = await runVerifyCommands('/tmp/wt', ['cmd'])

    expect(results[0]!.stderr).toContain(token)
    const warnContext = mockLoggerWarn.mock.calls[0]?.[0] as { stderrTail?: string } | undefined
    expect(warnContext?.stderrTail).toContain('[REDACTED]')
    expect(warnContext?.stderrTail).not.toContain(token)
  })

  it('splits command into binary and args', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runVerifyCommands('/tmp/wt', ['pnpm test --run'])

    expect(mockExeca).toHaveBeenCalledWith('pnpm', ['test', '--run'], expect.any(Object))
  })

  it('supports quoted command arguments', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runVerifyCommands('/tmp/wt', ['echo "hello world"'])

    expect(mockExeca).toHaveBeenCalledWith('echo', ['hello world'], expect.any(Object))
  })

  it('supports array-form commands', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runVerifyCommands('/tmp/wt', [['pnpm', 'lint']])

    expect(mockExeca).toHaveBeenCalledWith('pnpm', ['lint'], expect.any(Object))
  })

  it('uses default timeout when verify command does not override it', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runVerifyCommands('/tmp/wt', ['pnpm lint'])

    expect(mockExeca).toHaveBeenCalledWith(
      'pnpm',
      ['lint'],
      expect.objectContaining({ timeout: 60_000 }),
    )
  })

  it('uses per-command timeout override when configured', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runVerifyCommands('/tmp/wt', [
      { command: 'pnpm test', timeoutSeconds: 180 },
    ])

    expect(mockExeca).toHaveBeenCalledWith(
      'pnpm',
      ['test'],
      expect.objectContaining({ timeout: 180_000 }),
    )
  })

  it('records duration', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    const results = await runVerifyCommands('/tmp/wt', ['cmd'])

    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('runs before hooks, then the command, then after hooks in order', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runVerifyCommands('/tmp/wt', [
      {
        command: ['bundle', 'exec', 'rails', 'test'],
        before: [['docker', 'up']],
        after: [['docker', 'down']],
      },
    ])

    expect(mockExeca).toHaveBeenNthCalledWith(1, 'docker', ['up'], expect.any(Object))
    expect(mockExeca).toHaveBeenNthCalledWith(2, 'bundle', ['exec', 'rails', 'test'], expect.any(Object))
    expect(mockExeca).toHaveBeenNthCalledWith(3, 'docker', ['down'], expect.any(Object))
  })

  it('runs after hooks even when the command fails (finally)', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never) // before
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'tests failed' } as never) // command
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never) // after

    const results = await runVerifyCommands('/tmp/wt', [
      { command: 'rails test', before: [['docker', 'up']], after: [['docker', 'down']] },
    ])

    expect(results[0]!.passed).toBe(false)
    expect(mockExeca).toHaveBeenNthCalledWith(3, 'docker', ['down'], expect.any(Object))
  })

  it('skips the command but still runs after hooks when a before hook fails', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'compose up failed' } as never) // before fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never) // after

    const results = await runVerifyCommands('/tmp/wt', [
      { command: 'rails test', before: [['docker', 'up']], after: [['docker', 'down']] },
    ])

    expect(results).toHaveLength(1)
    expect(results[0]!.passed).toBe(false)
    // command itself must not have run
    expect(mockExeca).not.toHaveBeenCalledWith('rails', ['test'], expect.any(Object))
    // after still ran
    expect(mockExeca).toHaveBeenCalledWith('docker', ['down'], expect.any(Object))
  })

  it('runs all after hooks even when an earlier after hook fails (attempt-all)', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never) // command
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'down1 failed' } as never) // after 1
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never) // after 2

    const results = await runVerifyCommands('/tmp/wt', [
      { command: 'rails test', after: [['docker', 'down'], ['rm', 'tmpdb']] },
    ])

    expect(results[0]!.passed).toBe(true)
    expect(mockExeca).toHaveBeenCalledWith('docker', ['down'], expect.any(Object))
    expect(mockExeca).toHaveBeenCalledWith('rm', ['tmpdb'], expect.any(Object))
  })

  it('merges command env over the base env for the command and its hooks', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never)

    await runVerifyCommands(
      '/tmp/wt',
      [
        {
          command: 'rails test',
          before: [['docker', 'up']],
          env: { RAILS_ENV: 'test' },
        },
      ],
      { PATH: '/usr/bin' },
    )

    expect(mockExeca).toHaveBeenNthCalledWith(1, 'docker', ['up'],
      expect.objectContaining({ env: { PATH: '/usr/bin', RAILS_ENV: 'test' } }))
    expect(mockExeca).toHaveBeenNthCalledWith(2, 'rails', ['test'],
      expect.objectContaining({ env: { PATH: '/usr/bin', RAILS_ENV: 'test' } }))
  })
})

describe('allVerifyPassed', () => {
  it('returns true when all results passed', () => {
    const results = [
      { command: 'a', exitCode: 0, stdout: '', stderr: '', durationMs: 0, passed: true },
      { command: 'b', exitCode: 0, stdout: '', stderr: '', durationMs: 0, passed: true },
    ]
    expect(allVerifyPassed(results)).toBe(true)
  })

  it('returns false when any result failed', () => {
    const results = [
      { command: 'a', exitCode: 0, stdout: '', stderr: '', durationMs: 0, passed: true },
      { command: 'b', exitCode: 1, stdout: '', stderr: '', durationMs: 0, passed: false },
    ]
    expect(allVerifyPassed(results)).toBe(false)
  })

  it('returns true for empty results (vacuously true)', () => {
    expect(allVerifyPassed([])).toBe(true)
  })
})
