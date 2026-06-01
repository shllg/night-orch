import { describe, expect, it } from 'vitest'
import {
  collectMissingTitleTargets,
  issueKey,
  prKey,
  resolveIssueTitle,
  resolvePrTitle,
  type TitleLookup,
} from '../../../src/cli/tui/titles.js'
import type { RunListRow } from '../../../src/cli/tui/data.js'

describe('tui title helpers', () => {
  const lookup: TitleLookup = {
    issues: {
      [issueKey('org/repo', 1)]: 'Issue from lookup',
    },
    prs: {
      [prKey('org/repo', 10)]: 'PR from lookup',
    },
  }

  it('resolves issue/pr title from row first, then lookup', () => {
    const rowWithTitles = runRow({
      issue_title: 'Row issue',
      pr_number: 5,
      pr_title: 'Row PR',
    })
    const rowWithoutTitles = runRow({
      issue_number: 1,
      issue_title: null,
      pr_number: 10,
      pr_title: null,
    })

    expect(resolveIssueTitle(rowWithTitles, lookup)).toBe('Row issue')
    expect(resolvePrTitle(rowWithTitles, lookup)).toBe('Row PR')
    expect(resolveIssueTitle(rowWithoutTitles, lookup)).toBe('Issue from lookup')
    expect(resolvePrTitle(rowWithoutTitles, lookup)).toBe('PR from lookup')
  })

  it('collects unique missing title targets and skips attempted ones', () => {
    const rows: RunListRow[] = [
      runRow({ repo: 'org/repo', issue_number: 11, issue_title: null, pr_number: 101, pr_title: null }),
      runRow({ repo: 'org/repo', issue_number: 11, issue_title: null, pr_number: 101, pr_title: null }),
      runRow({ repo: 'org/repo', issue_number: 12, issue_title: null, pr_number: 102, pr_title: null }),
      runRow({ repo: 'org/repo', issue_number: 13, issue_title: null, pr_number: null, pr_title: null }),
    ]

    const attemptedIssues = new Set<string>([issueKey('org/repo', 12)])
    const attemptedPrs = new Set<string>([prKey('org/repo', 102)])

    const targets = collectMissingTitleTargets(rows, { issues: {}, prs: {} }, attemptedIssues, attemptedPrs, 10)

    expect(targets.issues).toEqual([
      { key: issueKey('org/repo', 11), repo: 'org/repo', issueNumber: 11 },
      { key: issueKey('org/repo', 13), repo: 'org/repo', issueNumber: 13 },
    ])
    expect(targets.prs).toEqual([
      { key: prKey('org/repo', 101), repo: 'org/repo', prNumber: 101 },
    ])
  })
})

function runRow(partial: Partial<RunListRow>): RunListRow {
  return {
    id: partial.id ?? 'run-1',
    run_id: partial.run_id ?? partial.id ?? 'run-1',
    repo: partial.repo ?? 'org/repo',
    issue_number: partial.issue_number ?? 1,
    issue_title: partial.issue_title ?? null,
    status: partial.status ?? 'running',
    current_phase: partial.current_phase ?? null,
    iteration_count: partial.iteration_count ?? 0,
    estimated_cost_usd: partial.estimated_cost_usd ?? 0,
    last_error: partial.last_error ?? null,
    pr_number: partial.pr_number ?? null,
    pr_title: partial.pr_title ?? null,
    created_at: partial.created_at ?? '2026-03-31T00:00:00.000Z',
    updated_at: partial.updated_at ?? '2026-03-31T00:00:00.000Z',
  }
}
