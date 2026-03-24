import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pushBranch } from '../../src/publishing/push.js'

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

describe('pushBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls git push with correct args', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    await pushBranch('/tmp/wt', 'orch/1-fix')

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['push', '--force-with-lease', '-u', 'origin', 'orch/1-fix'],
      { cwd: '/tmp/wt', timeout: 60_000 },
    )
  })

  it('succeeds on clean push', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    await expect(pushBranch('/tmp/wt', 'orch/1-fix')).resolves.toBeUndefined()
  })

  it('throws with clear message on push failure', async () => {
    mockExeca.mockRejectedValue({ stderr: 'fatal: remote hung up unexpectedly' })

    await expect(pushBranch('/tmp/wt', 'orch/1-fix')).rejects.toThrow(
      /Push failed for orch\/1-fix: fatal: remote hung up unexpectedly/,
    )
  })

  it('attempts rebase on rejected push (branch diverged)', async () => {
    // First push fails with rejected
    mockExeca.mockRejectedValueOnce({ stderr: '! [rejected] orch/1-fix -> orch/1-fix (non-fast-forward)' })
    // Rebase succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
    // Second push succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)

    await pushBranch('/tmp/wt', 'orch/1-fix')

    expect(mockExeca).toHaveBeenCalledTimes(3)
    expect(mockExeca).toHaveBeenNthCalledWith(2,
      'git',
      ['pull', '--rebase', 'origin', 'orch/1-fix'],
      expect.any(Object),
    )
    expect(mockExeca).toHaveBeenNthCalledWith(3,
      'git',
      ['push', '--force-with-lease', '-u', 'origin', 'orch/1-fix'],
      expect.any(Object),
    )
  })

  it('throws after rebase attempt fails', async () => {
    // First push fails with rejected
    mockExeca.mockRejectedValueOnce({ stderr: '! [rejected] non-fast-forward' })
    // Rebase fails
    mockExeca.mockRejectedValueOnce({ stderr: 'CONFLICT: merge conflict in src/a.ts' })

    await expect(pushBranch('/tmp/wt', 'orch/1-fix')).rejects.toThrow(
      /Push failed for orch\/1-fix after rebase attempt/,
    )
  })

  it('does not attempt rebase for non-rejection errors', async () => {
    mockExeca.mockRejectedValue({ stderr: 'fatal: Authentication failed' })

    await expect(pushBranch('/tmp/wt', 'orch/1-fix')).rejects.toThrow(
      /Push failed for orch\/1-fix: fatal: Authentication failed/,
    )
    // Only one call — no rebase attempt
    expect(mockExeca).toHaveBeenCalledTimes(1)
  })
})
