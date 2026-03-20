import { describe, it, expect } from 'vitest'
import { triageIssue } from '../../src/discovery/triage.js'
import type { ForgeIssue } from '../../src/forge/types.js'

function makeIssue(overrides: Partial<ForgeIssue> = {}): ForgeIssue {
  return {
    number: 1,
    nodeId: 'MDU6SXNzdWUx',
    title: 'Test issue',
    body: 'Fix the thing',
    labels: [],
    assignees: [],
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/org/repo/issues/1',
    ...overrides,
  }
}

describe('triageIssue', () => {
  it('classifies short bug issue as trivial', () => {
    const result = triageIssue(makeIssue({ labels: ['bug'], body: 'Fix the typo' }))
    expect(result.level).toBe('trivial')
  })

  it('classifies short typo issue as trivial', () => {
    const result = triageIssue(makeIssue({ labels: ['typo'], body: 'Wrong word' }))
    expect(result.level).toBe('trivial')
  })

  it('classifies standard feature request as standard', () => {
    const result = triageIssue(
      makeIssue({
        labels: ['enhancement'],
        body: 'Add a new button to the settings page that allows users to configure their notification preferences. This should include email, SMS, and push notification toggles.',
      }),
    )
    expect(result.level).toBe('standard')
  })

  it('classifies issue with refactor label as architectural', () => {
    const result = triageIssue(makeIssue({ labels: ['refactor'] }))
    expect(result.level).toBe('architectural')
  })

  it('classifies issue with breaking label as architectural', () => {
    const result = triageIssue(makeIssue({ labels: ['breaking'] }))
    expect(result.level).toBe('architectural')
  })

  it('classifies issue with 5+ file references as architectural', () => {
    const result = triageIssue(
      makeIssue({
        body: `Changes needed in:
src/auth/login.ts
src/auth/session.ts
src/models/user.ts
src/routes/api.ts
src/middleware/cors.ts
src/config/defaults.ts`,
      }),
    )
    expect(result.level).toBe('architectural')
  })

  it('architectural label takes priority over trivial', () => {
    const result = triageIssue(makeIssue({ labels: ['bug', 'refactor'], body: 'Short' }))
    expect(result.level).toBe('architectural')
  })

  it('long body with bug label is standard, not trivial', () => {
    const longBody = 'A'.repeat(300)
    const result = triageIssue(makeIssue({ labels: ['bug'], body: longBody }))
    expect(result.level).toBe('standard')
  })
})
