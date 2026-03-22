import { describe, it, expect, vi, beforeEach } from 'vitest'
import { commitChanges } from '../../src/loop/commit.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

vi.mock('../../src/loop/diff-guard.js', () => ({
  checkDiffSize: vi.fn(),
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
import { checkDiffSize } from '../../src/loop/diff-guard.js'

const mockExeca = vi.mocked(execa)
const mockCheckDiffSize = vi.mocked(checkDiffSize)

const limits = {
  maxChangedFiles: 50,
  maxChangedLines: 5000,
}

describe('commitChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns early when there are no changes', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' } as never)

    const result = await commitChanges('/tmp/wt', 1, 'No-op', limits)

    expect(result).toEqual({ committed: false, reason: 'No changes to commit' })
    expect(mockCheckDiffSize).not.toHaveBeenCalled()
  })

  it('stages before diff guard and commits when diff is acceptable', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: ' M src/a.ts\n' } as never) // git status
      .mockResolvedValueOnce({} as never) // git add -A
      .mockResolvedValueOnce({} as never) // git commit
    mockCheckDiffSize.mockResolvedValue({
      ok: true,
      stats: { changedFiles: 1, insertions: 1, deletions: 0, totalChangedLines: 1 },
      reason: null,
    })

    const result = await commitChanges('/tmp/wt', 42, 'Fix title', limits)

    expect(result.committed).toBe(true)
    expect(mockCheckDiffSize).toHaveBeenCalledWith('/tmp/wt', limits, { staged: true })
    expect(mockExeca).toHaveBeenCalledWith('git', ['add', '-A'], { cwd: '/tmp/wt' })
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'night-orch: implement #42 Fix title'],
      { cwd: '/tmp/wt' },
    )
  })

  it('sanitizes issue title in commit message', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: ' M src/a.ts\n' } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
    mockCheckDiffSize.mockResolvedValue({
      ok: true,
      stats: { changedFiles: 1, insertions: 1, deletions: 0, totalChangedLines: 1 },
      reason: null,
    })

    await commitChanges('/tmp/wt', 1, 'Fix\nInjected trailer: value', limits)

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'night-orch: implement #1 Fix Injected trailer: value'],
      { cwd: '/tmp/wt' },
    )
  })

  it('resets staged changes when diff guard fails', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: '?? new-file.ts\n' } as never)
      .mockResolvedValueOnce({} as never) // add
      .mockResolvedValueOnce({} as never) // reset
    mockCheckDiffSize.mockResolvedValue({
      ok: false,
      stats: { changedFiles: 999, insertions: 0, deletions: 0, totalChangedLines: 0 },
      reason: 'Too many changed files: 999 > 50',
    })

    const result = await commitChanges('/tmp/wt', 1, 'Big diff', limits)

    expect(result.committed).toBe(false)
    expect(result.reason).toContain('Diff-size guard')
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['reset', 'HEAD', '--', '.'],
      { cwd: '/tmp/wt', reject: false },
    )
  })
})
