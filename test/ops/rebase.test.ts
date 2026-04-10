import { describe, it, expect, vi, beforeEach } from 'vitest'
import { autoRebase, type RebaseTarget } from '../../src/ops/rebase.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

import { execa } from 'execa'

const mockExeca = vi.mocked(execa)

const target: RebaseTarget = {
  repo: 'org/repo',
  issueNumber: 1,
  prNumber: 10,
  branchName: 'orch/1-fix',
  baseBranch: 'main',
  worktreePath: '/tmp/wt',
}

describe('autoRebase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns up_to_date when base is ancestor of HEAD', async () => {
    // fetch succeeds
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
    // merge-base --is-ancestor succeeds (exit 0 = is ancestor)
    mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)

    const result = await autoRebase(target, '/tmp/repo')
    expect(result.result).toBe('up_to_date')
    expect(mockExeca).toHaveBeenCalledTimes(2)
  })

  describe('merge strategy (default)', () => {
    it('merges and pushes when base is not ancestor', async () => {
      // fetch succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
      // merge-base --is-ancestor fails (not ancestor)
      mockExeca.mockRejectedValueOnce(new Error('exit code 1'))
      // merge succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
      // push succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)

      const result = await autoRebase(target, '/tmp/repo', 'merge')
      expect(result.result).toBe('rebased')
      expect(mockExeca).toHaveBeenCalledTimes(4)
      // Check merge command
      expect(mockExeca).toHaveBeenNthCalledWith(3,
        'git',
        ['merge', 'origin/main', '--no-edit'],
        expect.any(Object),
      )
      // Check push uses --force-with-lease
      expect(mockExeca).toHaveBeenNthCalledWith(4,
        'git',
        ['push', '--force-with-lease', 'origin', 'orch/1-fix'],
        expect.any(Object),
      )
    })

    it('returns conflict and aborts when merge has conflicts', async () => {
      // fetch succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
      // merge-base fails (not ancestor)
      mockExeca.mockRejectedValueOnce(new Error('exit code 1'))
      // merge fails with conflict
      mockExeca.mockRejectedValueOnce({ stderr: 'CONFLICT (content): Automatic merge failed' })
      // merge --abort succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)

      const result = await autoRebase(target, '/tmp/repo', 'merge')
      expect(result.result).toBe('conflict')
      expect(mockExeca).toHaveBeenCalledTimes(4)
      expect(mockExeca).toHaveBeenNthCalledWith(4,
        'git',
        ['merge', '--abort'],
        expect.any(Object),
      )
    })
  })

  describe('rebase strategy', () => {
    it('rebases and pushes when base is not ancestor', async () => {
      // fetch succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
      // merge-base --is-ancestor fails (not ancestor)
      mockExeca.mockRejectedValueOnce(new Error('exit code 1'))
      // rebase succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
      // push succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)

      const result = await autoRebase(target, '/tmp/repo', 'rebase')
      expect(result.result).toBe('rebased')
      expect(mockExeca).toHaveBeenCalledTimes(4)
      // Check push uses --force-with-lease
      expect(mockExeca).toHaveBeenNthCalledWith(4,
        'git',
        ['push', '--force-with-lease', 'origin', 'orch/1-fix'],
        expect.any(Object),
      )
    })

    it('returns conflict and aborts when rebase has conflicts', async () => {
      // fetch succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)
      // merge-base fails (not ancestor)
      mockExeca.mockRejectedValueOnce(new Error('exit code 1'))
      // rebase fails with conflict
      mockExeca.mockRejectedValueOnce({ stderr: 'CONFLICT (content): Merge conflict in src/main.ts' })
      // list conflicted files
      mockExeca.mockResolvedValueOnce({ stdout: '' } as never)
      // rebase --abort succeeds
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never)

      const result = await autoRebase(target, '/tmp/repo', 'rebase')
      expect(result.result).toBe('conflict')
      expect(result.conflictAnalysis?.files).toEqual([])
      expect(mockExeca).toHaveBeenCalledTimes(5)
      expect(mockExeca).toHaveBeenNthCalledWith(5,
        'git',
        ['rebase', '--abort'],
        expect.any(Object),
      )
    })
  })

  it('returns error when fetch fails', async () => {
    mockExeca.mockRejectedValueOnce(new Error('network error'))

    const result = await autoRebase(target, '/tmp/repo')
    expect(result.result).toBe('error')
  })
})
