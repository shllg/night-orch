import { describe, expect, it } from 'vitest'
import { mapActiveRunRow, mapInboxIssueRow } from '../../src/state/run-mapper.js'
import type { InboxIssueRow } from '../../src/state/inbox-queries.js'
import type { RunListRow } from '../../src/state/run-list.js'

function makeInboxIssueRow(overrides: Partial<InboxIssueRow> = {}): InboxIssueRow {
  return {
    repo: 'org/repo',
    issue_number: 1,
    issue_title: 'Issue',
    status: 'blocked',
    current_phase: null,
    iteration_count: null,
    estimated_cost_usd: null,
    last_error: null,
    block_reason: null,
    pr_number: null,
    pr_title: null,
    updated_at: null,
    run_id: 'run-1',
    manual_state: null,
    operation_intent: null,
    ...overrides,
  }
}

function makeRunListRow(overrides: Partial<RunListRow> = {}): RunListRow {
  return {
    id: 'run-1',
    run_id: 'run-1',
    repo: 'org/repo',
    issue_number: 1,
    issue_title: 'Issue',
    status: 'running',
    current_phase: 'code',
    iteration_count: 2,
    estimated_cost_usd: 1.25,
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_tokens: 25,
    last_error: null,
    pr_number: null,
    pr_title: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:05:00.000Z',
    ...overrides,
  }
}

describe('mapActiveRunRow', () => {
  it('uses explicit run_id to identify real run rows', () => {
    const item = mapActiveRunRow(
      makeRunListRow(),
      { id: 'run-1', started_at: '2026-01-01T00:00:00.000Z', ended_at: null },
    )

    expect(item.runId).toBe('run-1')
    expect(item.hasRun).toBe(true)
    expect(item.startedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('builds a synthetic issue id only when run_id is null', () => {
    const item = mapActiveRunRow(
      makeRunListRow({ id: 'display-row', run_id: null, repo: 'org/repo', issue_number: 42 }),
      undefined,
    )

    expect(item.runId).toBe('issue:org/repo#42')
    expect(item.hasRun).toBe(false)
    expect(item.startedAt).toBeNull()
  })
})

describe('mapInboxIssueRow', () => {
  it('coerces DB intent and manual-state strings to domain variants', () => {
    const item = mapInboxIssueRow(
      makeInboxIssueRow({
        manual_state: 'unknown-manual-state',
        operation_intent: 'unknown-intent',
      }),
      'blocked',
      { recommendedCommand: null, availableCommands: [] },
    )

    expect(item.manualState).toBe('none')
    expect(item.operationIntent).toBe('auto')
  })

  it('preserves valid domain intent and manual-state values', () => {
    const item = mapInboxIssueRow(
      makeInboxIssueRow({
        manual_state: 'awaiting_rebase_resolution',
        operation_intent: 'refresh',
      }),
      'needs_human',
      { recommendedCommand: '/orch rebase', availableCommands: ['/orch rebase'] },
    )

    expect(item.manualState).toBe('awaiting_rebase_resolution')
    expect(item.operationIntent).toBe('refresh')
  })
})
