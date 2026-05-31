import { describe, it, expect } from 'vitest'
import { isEligible, filterEligible } from '../../src/discovery/selector.js'
import type { ForgeIssue } from '../../src/forge/types.js'

function makeIssue(labels: string[]): ForgeIssue {
  return {
    number: 1,
    nodeId: 'MDU6SXNzdWUx',
    title: 'Test issue',
    body: 'Test body',
    labels,
    assignees: [],
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/org/repo/issues/1',
  }
}

describe('isEligible', () => {
  it('matches issue with an include label', () => {
    const issue = makeIssue(['no:ready', 'bug'])
    expect(isEligible(issue, { includeLabelsAny: ['no:ready'], excludeLabelsAny: [] })).toBe(true)
  })

  it('rejects issue missing all include labels', () => {
    const issue = makeIssue(['bug'])
    expect(isEligible(issue, { includeLabelsAny: ['no:ready'], excludeLabelsAny: [] })).toBe(false)
  })

  it('rejects issue with an exclude label', () => {
    const issue = makeIssue(['no:ready', 'no:blocked'])
    expect(
      isEligible(issue, { includeLabelsAny: ['no:ready'], excludeLabelsAny: ['no:blocked'] }),
    ).toBe(false)
  })

  it('exclude takes priority over include', () => {
    const issue = makeIssue(['no:ready', 'no:error'])
    expect(
      isEligible(issue, {
        includeLabelsAny: ['no:ready'],
        excludeLabelsAny: ['no:error'],
      }),
    ).toBe(false)
  })

  it('empty includeLabelsAny matches all issues', () => {
    const issue = makeIssue(['random-label'])
    expect(isEligible(issue, { includeLabelsAny: [], excludeLabelsAny: [] })).toBe(true)
  })

  it('empty excludeLabelsAny excludes nothing', () => {
    const issue = makeIssue(['no:ready'])
    expect(isEligible(issue, { includeLabelsAny: ['no:ready'], excludeLabelsAny: [] })).toBe(true)
  })
})

describe('filterEligible', () => {
  it('filters a batch of issues', () => {
    const issues = [
      makeIssue(['no:ready']),
      makeIssue(['bug']),
      makeIssue(['no:ready', 'no:blocked']),
    ]
    const result = filterEligible(issues, {
      includeLabelsAny: ['no:ready'],
      excludeLabelsAny: ['no:blocked'],
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.labels).toContain('no:ready')
  })
})
