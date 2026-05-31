import { describe, it, expect } from 'vitest'
import { buildPlanningPrdPath, isPlanningIssue, normalizeRepoRelativePath } from '../../src/planning/mode.js'

describe('isPlanningIssue', () => {
  it('returns true when planning label is present', () => {
    expect(isPlanningIssue(['bug', 'no:planning'], { labels: { planning: 'no:planning' } } as never)).toBe(true)
  })

  it('returns false when planning label is absent', () => {
    expect(isPlanningIssue(['bug'], { labels: { planning: 'no:planning' } } as never)).toBe(false)
  })
})

describe('buildPlanningPrdPath', () => {
  it('builds deterministic path from issue number and title', () => {
    const path = buildPlanningPrdPath(42, 'Add SSO + SCIM Support', {
      planning: { prdDirectory: 'docs/prd' },
    } as never)
    expect(path).toBe('docs/prd/42-add-sso-scim-support.md')
  })

  it('normalizes odd directory formatting', () => {
    const path = buildPlanningPrdPath(7, 'Test', {
      planning: { prdDirectory: './docs//prd/' },
    } as never)
    expect(path).toBe('docs/prd/7-test.md')
  })
})

describe('normalizeRepoRelativePath', () => {
  it('normalizes slashes and leading ./', () => {
    expect(normalizeRepoRelativePath('./docs\\prd//x')).toBe('docs/prd/x')
  })
})
