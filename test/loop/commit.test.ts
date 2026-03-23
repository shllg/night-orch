import { describe, it, expect, vi, beforeEach } from 'vitest'
import { commitChanges } from '../../src/loop/commit.js'
import { execa } from 'execa'
import { checkDiffSize } from '../../src/loop/diff-guard.js'

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

const mockExeca = vi.mocked(execa)
const mockCheckDiffSize = vi.mocked(checkDiffSize)

const limits = {
  maxChangedFiles: 50,
  maxChangedLines: 5000,
}

const securityConfig = {
  ...limits,
  maxDailyCostUsd: 50,
  maxCostPerRunUsd: 10,
}

describe('commitChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns early when there are no changes', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' } as never)

    const result = await commitChanges('/tmp/wt', 1, 'No-op', securityConfig)

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
      reason: null,
      stats: { changedFiles: 1, insertions: 1, deletions: 0, totalChangedLines: 1 },
    })

    const result = await commitChanges('/tmp/wt', 42, 'Fix title', securityConfig)

    expect(result.committed).toBe(true)
    expect(mockCheckDiffSize).toHaveBeenCalledWith('/tmp/wt', securityConfig, { staged: true })
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

    await commitChanges('/tmp/wt', 1, 'Fix\nInjected trailer: value', securityConfig)

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

    const result = await commitChanges('/tmp/wt', 1, 'Big diff', securityConfig)

    expect(result.committed).toBe(false)
    expect(result.reason).toContain('Diff-size guard')
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['reset', 'HEAD', '--', '.'],
      { cwd: '/tmp/wt', reject: false },
    )
  })
})

describe('commitChanges planning guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckDiffSize.mockResolvedValue({
      ok: true,
      reason: null,
      stats: { changedFiles: 1, insertions: 10, deletions: 0, totalChangedLines: 10 },
    })
  })

  it('blocks commit when planning mode changes more than one file', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: '?? docs/prd/issue-1.md\n M src/index.ts\n',
    } as never)

    const result = await commitChanges('/tmp/wt', 1, 'Planning issue', securityConfig, {
      planningOutputDir: 'docs/prd',
    })

    expect(result.committed).toBe(false)
    expect(result.reason).toContain('Planning guard')
    expect(mockExeca).toHaveBeenCalledTimes(1)
  })

  it('blocks commit when markdown file is outside configured planning directory', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: '?? planning/issue-1.md\n',
    } as never)

    const result = await commitChanges('/tmp/wt', 1, 'Planning issue', securityConfig, {
      planningOutputDir: 'docs/prd',
    })

    expect(result.committed).toBe(false)
    expect(result.reason).toContain('Planning guard')
    expect(result.reason).toContain('docs/prd')
    expect(mockExeca).toHaveBeenCalledTimes(1)
  })

  it('allows commit when planning mode changes exactly one markdown file in the planning directory', async () => {
    mockExeca.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'status') {
        return { stdout: '?? docs/prd/issue-1.md\n' } as never
      }
      return { stdout: '' } as never
    })

    const result = await commitChanges('/tmp/wt', 1, 'Planning issue', securityConfig, {
      planningOutputDir: 'docs/prd',
    })

    expect(result.committed).toBe(true)
    expect(result.reason).toBeNull()
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', expect.stringContaining('night-orch: implement #1')],
      { cwd: '/tmp/wt' },
    )
  })
})
