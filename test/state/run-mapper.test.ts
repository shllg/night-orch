import { describe, expect, it } from 'vitest'
import { mapInboxIssueRow } from '../../src/state/run-mapper.js'
import type { InboxIssueRow } from '../../src/state/inbox-queries.js'

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
