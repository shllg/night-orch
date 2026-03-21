import { describe, it, expect, vi } from 'vitest'
import { execWithTimeout } from '../../src/workers/timeout.js'

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}))

import { execa } from 'execa'

const mockExeca = vi.mocked(execa)

describe('execWithTimeout', () => {
  it('returns stdout, stderr, and exit code on success', async () => {
    mockExeca.mockResolvedValue({
      stdout: 'hello world',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    } as never)

    const result = await execWithTimeout('echo', ['hello'], {
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      timeoutMs: 5000,
    })

    expect(result.stdout).toBe('hello world')
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('passes correct options to execa', async () => {
    mockExeca.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    } as never)

    await execWithTimeout('my-cmd', ['--flag', 'value'], {
      cwd: '/work',
      env: { HOME: '/home/test' },
      timeoutMs: 30000,
      stdin: 'input data',
    })

    expect(mockExeca).toHaveBeenCalledWith('my-cmd', ['--flag', 'value'], {
      cwd: '/work',
      env: { HOME: '/home/test' },
      timeout: 30000,
      reject: false,
      input: 'input data',
      killSignal: 'SIGTERM',
      forceKillAfterDelay: 5000,
    })
  })

  it('reports timedOut when execa indicates timeout', async () => {
    mockExeca.mockResolvedValue({
      stdout: 'partial',
      stderr: 'timeout',
      exitCode: null,
      timedOut: true,
    } as never)

    const result = await execWithTimeout('slow-cmd', [], {
      cwd: '/tmp',
      env: {},
      timeoutMs: 1000,
    })

    expect(result.timedOut).toBe(true)
    expect(result.stdout).toBe('partial')
  })

  it('handles non-zero exit code', async () => {
    mockExeca.mockResolvedValue({
      stdout: '',
      stderr: 'Error: something failed',
      exitCode: 1,
      timedOut: false,
    } as never)

    const result = await execWithTimeout('failing-cmd', [], {
      cwd: '/tmp',
      env: {},
      timeoutMs: 5000,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('Error: something failed')
    expect(result.timedOut).toBe(false)
  })

  it('handles execa throwing an error', async () => {
    mockExeca.mockRejectedValue({
      stdout: 'partial output',
      stderr: 'crash',
      exitCode: 137,
      timedOut: false,
    })

    const result = await execWithTimeout('crashing-cmd', [], {
      cwd: '/tmp',
      env: {},
      timeoutMs: 5000,
    })

    expect(result.exitCode).toBe(137)
    expect(result.stdout).toBe('partial output')
    expect(result.stderr).toBe('crash')
  })

  it('handles execa throwing with missing fields', async () => {
    mockExeca.mockRejectedValue(new Error('spawn ENOENT'))

    const result = await execWithTimeout('nonexistent', [], {
      cwd: '/tmp',
      env: {},
      timeoutMs: 5000,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('spawn ENOENT')
  })

  it('detects timeout from duration when timedOut flag is missing', async () => {
    // Simulate: execa throws without timedOut field, but duration >= timeoutMs
    const err = { stdout: '', stderr: 'killed', exitCode: 143 }
    mockExeca.mockImplementation(() => {
      return new Promise((_, reject) => {
        // Reject immediately — the function checks durationMs >= timeoutMs
        reject(err)
      }) as never
    })

    // Use a very small timeout so durationMs is likely >= timeoutMs
    const result = await execWithTimeout('cmd', [], {
      cwd: '/tmp',
      env: {},
      timeoutMs: 0,
    })

    // timedOut should be true since durationMs >= timeoutMs (0)
    expect(result.timedOut).toBe(true)
  })

  it('measures duration correctly', async () => {
    mockExeca.mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
        }, 50)
      }) as never
    })

    const result = await execWithTimeout('cmd', [], {
      cwd: '/tmp',
      env: {},
      timeoutMs: 5000,
    })

    expect(result.durationMs).toBeGreaterThanOrEqual(40)
  })
})
