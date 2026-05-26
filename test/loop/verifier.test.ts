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

const mockExeca = vi.mocked(execa)

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
