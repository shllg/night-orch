import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pushBranch, MergeConflictError } from '../../src/publishing/push.js'

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
      expect.objectContaining({ cwd: '/tmp/wt', timeout: 60_000, extendEnv: false }),
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

  it('attempts merge reconciliation on rejected push by default', async () => {
    // First push fails with rejected
    mockExeca.mockRejectedValueOnce({ stderr: '! [rejected] orch/1-fix -> orch/1-fix (non-fast-forward)' })
    // fetch succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
    // merge succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
    // Second push succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)

    await pushBranch('/tmp/wt', 'orch/1-fix')

    expect(mockExeca).toHaveBeenCalledTimes(4)
    expect(mockExeca).toHaveBeenNthCalledWith(2,
      'git',
      ['fetch', 'origin', 'orch/1-fix'],
      expect.any(Object),
    )
    expect(mockExeca).toHaveBeenNthCalledWith(3,
      'git',
      ['merge', 'origin/orch/1-fix', '--no-edit'],
      expect.any(Object),
    )
    expect(mockExeca).toHaveBeenNthCalledWith(4,
      'git',
      ['push', '--force-with-lease', '-u', 'origin', 'orch/1-fix'],
      expect.any(Object),
    )
  })

  it('throws MergeConflictError after merge reconciliation hits conflicts', async () => {
    // First push fails with rejected
    mockExeca.mockRejectedValueOnce({ stderr: '! [rejected] non-fast-forward' })
    // fetch succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
    // merge fails with CONFLICT
    mockExeca.mockRejectedValueOnce({ stderr: 'CONFLICT: merge conflict in src/a.ts' })
    // merge --abort succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)

    const err = await pushBranch('/tmp/wt', 'orch/1-fix').catch((e: unknown) => e) as MergeConflictError
    expect(err).toBeInstanceOf(MergeConflictError)
    expect(err.code).toBe('MERGE_CONFLICT')
    expect(err.message).toMatch(/merge conflicts/)
  })

  it('can still use rebase reconciliation when explicitly requested', async () => {
    // First push fails with rejected
    mockExeca.mockRejectedValueOnce({ stderr: '! [rejected] non-fast-forward' })
    // fetch succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
    // Rebase succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
    // Second push succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)

    await expect(pushBranch('/tmp/wt', 'orch/1-fix', 'rebase')).resolves.toBeUndefined()
    expect(mockExeca).toHaveBeenNthCalledWith(3,
      'git',
      ['rebase', 'origin/orch/1-fix'],
      expect.any(Object),
    )
  })

  it('throws generic error after reconciliation attempt fails without conflicts', async () => {
    // First push fails with rejected
    mockExeca.mockRejectedValueOnce({ stderr: '! [rejected] non-fast-forward' })
    // fetch succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
    // merge fails with non-conflict error
    mockExeca.mockRejectedValueOnce({ stderr: 'fatal: cannot merge' })

    await expect(pushBranch('/tmp/wt', 'orch/1-fix')).rejects.toThrow(
      /Push failed for orch\/1-fix after merge reconciliation attempt/,
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
