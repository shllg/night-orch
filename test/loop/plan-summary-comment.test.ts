import { describe, it, expect, vi } from 'vitest'
import { formatPlanSummaryComment, postPlanSummaryComment } from '../../src/loop/plan-summary-comment.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { PlannerOutput } from '../../src/workers/types.js'

function makePlan(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    objective: 'Ship the issue fix',
    assumptions: [],
    filesToChange: ['src/a.ts'],
    steps: [
      { order: 2, description: 'Implement the change', files: ['src/a.ts'] },
      { order: 1, description: 'Prepare the update', files: ['src/a.ts'] },
    ],
    risks: ['Regression risk in parser behavior'],
    testStrategy: 'Run pnpm test and manual smoke checks',
    ...overrides,
  }
}

function makeMockForge(commentOnIssue = vi.fn().mockResolvedValue(undefined)): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    commentOnIssue,
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
  }
}

describe('formatPlanSummaryComment', () => {
  it('includes clear night-orch attribution and core plan sections', () => {
    const comment = formatPlanSummaryComment(makePlan())

    expect(comment).toContain('[night-orch] Plan Summary')
    expect(comment).toContain('**Automated comment** posted by **night-orch**')
    expect(comment).toContain('**Objective:** Ship the issue fix')
    expect(comment).toContain('1. Prepare the update')
    expect(comment).toContain('2. Implement the change')
    expect(comment).toContain('`src/a.ts`')
    expect(comment).toContain('**Top risks:**')
    expect(comment).toContain('**Test strategy:** Run pnpm test and manual smoke checks')
  })

  it('summarizes long sections instead of dumping full plan content', () => {
    const comment = formatPlanSummaryComment(makePlan({
      steps: [
        { order: 1, description: 'Step 1', files: ['src/a.ts'] },
        { order: 2, description: 'Step 2', files: ['src/b.ts'] },
        { order: 3, description: 'Step 3', files: ['src/c.ts'] },
        { order: 4, description: 'Step 4', files: ['src/d.ts'] },
        { order: 5, description: 'Step 5', files: ['src/e.ts'] },
        { order: 6, description: 'Step 6', files: ['src/f.ts'] },
        { order: 7, description: 'Step 7', files: ['src/g.ts'] },
      ],
      filesToChange: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts'],
      risks: ['r1', 'r2', 'r3', 'r4', 'r5'],
    }))

    expect(comment).toContain('...and 1 more planned step(s).')
    expect(comment).toContain('- ...and 1 more file(s).')
    expect(comment).toContain('- ...and 1 more risk(s).')
  })
})

describe('postPlanSummaryComment', () => {
  it('posts formatted summary comment when plan exists', async () => {
    const commentOnIssue = vi.fn().mockResolvedValue(undefined)
    const forge = makeMockForge(commentOnIssue)

    const posted = await postPlanSummaryComment(forge, 'org/repo', 7, makePlan())

    expect(posted).toBe(true)
    expect(commentOnIssue).toHaveBeenCalledTimes(1)
    expect(commentOnIssue).toHaveBeenCalledWith(
      'org/repo',
      7,
      expect.stringContaining('## 🤖 [night-orch] Plan Summary'),
    )
  })

  it('propagates forge API failures to caller', async () => {
    const commentOnIssue = vi.fn().mockRejectedValue(new Error('forge unavailable'))
    const forge = makeMockForge(commentOnIssue)

    await expect(postPlanSummaryComment(forge, 'org/repo', 7, makePlan())).rejects.toThrow('forge unavailable')
  })

  it('does not post when plan output is missing', async () => {
    const commentOnIssue = vi.fn().mockResolvedValue(undefined)
    const forge = makeMockForge(commentOnIssue)

    const posted = await postPlanSummaryComment(forge, 'org/repo', 7, null)

    expect(posted).toBe(false)
    expect(commentOnIssue).not.toHaveBeenCalled()
  })

  it('does not post when plan output has no meaningful content', async () => {
    const commentOnIssue = vi.fn().mockResolvedValue(undefined)
    const forge = makeMockForge(commentOnIssue)

    const posted = await postPlanSummaryComment(
      forge,
      'org/repo',
      7,
      makePlan({
        objective: '   ',
        filesToChange: [],
        steps: [],
        risks: [],
        testStrategy: '   ',
      }),
    )

    expect(posted).toBe(false)
    expect(commentOnIssue).not.toHaveBeenCalled()
  })
})
