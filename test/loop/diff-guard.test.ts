import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkDiffSize } from '../../src/loop/diff-guard.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

import { execa } from 'execa'

const mockExeca = vi.mocked(execa)

const defaultLimits = { maxChangedFiles: 50, maxChangedLines: 5000 }

describe('checkDiffSize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok for diff under limits', async () => {
    mockExeca.mockResolvedValue({
      stdout: ' src/auth/login.ts | 10 +++++++---\n src/config.ts     |  5 +++++\n 2 files changed, 12 insertions(+), 3 deletions(-)\n',
    } as never)

    const result = await checkDiffSize('/tmp/wt', defaultLimits)

    expect(result.ok).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.stats.changedFiles).toBe(2)
    expect(result.stats.insertions).toBe(12)
    expect(result.stats.deletions).toBe(3)
    expect(result.stats.totalChangedLines).toBe(15)
  })

  it('returns not ok when maxChangedFiles exceeded', async () => {
    mockExeca.mockResolvedValue({
      stdout: ' 51 files changed, 100 insertions(+), 50 deletions(-)\n',
    } as never)

    const result = await checkDiffSize('/tmp/wt', defaultLimits)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Too many changed files')
    expect(result.reason).toContain('51')
  })

  it('returns not ok when maxChangedLines exceeded', async () => {
    mockExeca.mockResolvedValue({
      stdout: ' 3 files changed, 4000 insertions(+), 2000 deletions(-)\n',
    } as never)

    const result = await checkDiffSize('/tmp/wt', defaultLimits)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Too many changed lines')
    expect(result.reason).toContain('6000')
  })

  it('returns ok for empty diff (no changes)', async () => {
    mockExeca.mockResolvedValue({ stdout: '' } as never)

    const result = await checkDiffSize('/tmp/wt', defaultLimits)

    expect(result.ok).toBe(true)
    expect(result.stats.changedFiles).toBe(0)
    expect(result.stats.totalChangedLines).toBe(0)
  })

  it('parses single file change', async () => {
    mockExeca.mockResolvedValue({
      stdout: ' src/main.ts | 5 +++++\n 1 file changed, 5 insertions(+)\n',
    } as never)

    const result = await checkDiffSize('/tmp/wt', defaultLimits)

    expect(result.ok).toBe(true)
    expect(result.stats.changedFiles).toBe(1)
    expect(result.stats.insertions).toBe(5)
    expect(result.stats.deletions).toBe(0)
  })

  it('parses deletions only', async () => {
    mockExeca.mockResolvedValue({
      stdout: ' src/old.ts | 20 --------------------\n 1 file changed, 20 deletions(-)\n',
    } as never)

    const result = await checkDiffSize('/tmp/wt', defaultLimits)

    expect(result.stats.insertions).toBe(0)
    expect(result.stats.deletions).toBe(20)
    expect(result.stats.totalChangedLines).toBe(20)
  })

  it('checks files limit before lines limit', async () => {
    // Both limits exceeded — should report files first
    mockExeca.mockResolvedValue({
      stdout: ' 100 files changed, 10000 insertions(+)\n',
    } as never)

    const result = await checkDiffSize('/tmp/wt', defaultLimits)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('files')
  })
})
