import { describe, expect, it } from 'vitest'
import { buildIssueRowViewModel } from '../../src/components/issue-row/view-model.js'

describe('buildIssueRowViewModel', () => {
  it('builds a stable cross-surface view model', () => {
    const model = buildIssueRowViewModel({
      repo: 'night-orch/night-orch',
      issueNumber: 107,
      title: 'Storybook and components structure',
      status: 'running',
      branch: 'orch/issue-107',
      updatedAtIso: '2026-04-04T20:30:00Z',
    })

    expect(model).toEqual({
      issueRef: 'night-orch/night-orch#107',
      title: 'Storybook and components structure',
      status: 'running',
      statusLabel: 'running',
      branchLabel: 'branch orch/issue-107',
      updatedAtLabel: 'updated 2026-04-04T20:30Z',
    })
  })

  it('falls back when optional fields are absent', () => {
    const model = buildIssueRowViewModel({
      repo: 'night-orch/night-orch',
      issueNumber: 108,
      title: 'Fallback values',
      status: 'queued',
    })

    expect(model.branchLabel).toBe('branch --')
    expect(model.updatedAtLabel).toBe('updated --')
  })
})
