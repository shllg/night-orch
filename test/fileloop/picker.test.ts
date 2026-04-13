import { describe, expect, it } from 'vitest'
import type { FileLoopConfig } from '../../src/config/schema.js'
import { compareCandidates, pickNext } from '../../src/fileloop/picker.js'
import { initDatabase } from '../../src/state/db.js'
import { FileLoopFileStateStore } from '../../src/fileloop/file-state.js'

const config: FileLoopConfig = {
  enabled: true,
  maxDurationMinutes: 60,
  maxIterations: 100,
  minIntervalSecondsBetweenFiles: 5,
  perIterationTimeoutSeconds: 30,
  maxCostUsd: 5,
  maxFileLines: 100,
  includeGlobs: ['**/*.{ts,md}'],
  excludeGlobs: ['**/*.snap', 'loop.md'],
  reviewerProfileKey: 'cheap',
  branchNameTemplate: 'orch/file-loop/{repoSlug}/{yyyyMmDd}',
  loopMdPath: 'loop.md',
  commitPrefix: '[FILE-LOOP]',
  perEditVerify: { enabled: true, commands: ['pnpm typecheck'], timeoutSeconds: 10 },
  finalizeVerify: { enabled: true, commands: ['pnpm typecheck'], timeoutSeconds: 10, onFailure: 'draft-pr' },
}

describe('file-loop picker', () => {
  it('sorts null-first then oldest touched, with deterministic tiebreaks', () => {
    const random = () => 0.1
    expect(compareCandidates(
      { filePath: 'b.ts', lineCount: 5, lastTouchedAt: null },
      { filePath: 'a.ts', lineCount: 5, lastTouchedAt: '2026-04-13T10:00:00.000Z' },
      random,
    )).toBeLessThan(0)

    expect(compareCandidates(
      { filePath: 'a.ts', lineCount: 5, lastTouchedAt: '2026-04-13T08:00:00.000Z' },
      { filePath: 'b.ts', lineCount: 5, lastTouchedAt: '2026-04-13T10:00:00.000Z' },
      random,
    )).toBeLessThan(0)
  })

  it('filters by glob, binary, and line-count limits', async () => {
    const db = initDatabase(':memory:')
    const store = new FileLoopFileStateStore(db)
    store.upsert({
      repo: 'org/repo',
      filePath: 'src/old.ts',
      lastTouchedAt: '2026-04-13T08:00:00.000Z',
      incrementTouchCount: true,
    })

    const picked = await pickNext('org/repo', '/tmp/worktree', config, store, {
      listTrackedFiles: async () => ['src/old.ts', 'src/new.ts', 'notes.snap', 'loop.md'],
      getLineCount: async (path) => path.endsWith('new.ts') ? 10 : 10,
      isBinaryFile: async (_wt, filePath) => filePath === 'src/old.ts',
      random: () => 0.1,
    })

    expect(picked?.filePath).toBe('src/new.ts')
    db.close()
  })
})
