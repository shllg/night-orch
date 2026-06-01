import type { InboxCommandHints, InboxTriage } from '../discovery/triage.js'
import type { RunListRow } from './run-list.js'
import type { InboxIssueRow } from './inbox-queries.js'
import type { HistoryRunRow, RunTimingRow } from './run-queries.js'
import { coerceManualState, coerceOperationIntent, type RunManualState, type RunOperationIntent } from './runs.js'
import { parseUtcTimestampMs } from '../utils/time.js'

const INBOX_TRIAGE_SORT_ORDER: Record<InboxTriage, number> = {
  needs_human: 0,
  review_ready: 1,
  blocked: 2,
  error: 3,
}

export interface RunSummaryRow {
  runId: string
  hasRun: boolean
  repo: string
  issue: number
  status: string
  issueTitle: string | null
  prNumber: number | null
  phase: string | null
  iterations: number
  costUsd: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  lastError: string | null
  startedAt: string | null
  endedAt: string | null
}

export interface InboxItemRow {
  runId: string
  repo: string
  issue: number
  issueTitle: string | null
  status: string
  triage: InboxTriage
  phase: string | null
  iterations: number
  costUsd: number
  prNumber: number | null
  prTitle: string | null
  blockReason: string | null
  lastError: string | null
  reason: string | null
  manualState: RunManualState
  operationIntent: RunOperationIntent
  recommendedCommand: string | null
  availableCommands: string[]
  updatedAt: string | null
}

export function mapHistoryRunRow(row: HistoryRunRow): RunSummaryRow {
  return {
    runId: row.id,
    hasRun: true,
    repo: row.repo,
    issue: row.issue_number,
    status: row.status,
    issueTitle: row.issue_title,
    prNumber: row.pr_number,
    phase: row.current_phase,
    iterations: row.iteration_count ?? 0,
    costUsd: row.estimated_cost_usd ?? 0,
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    lastError: row.last_error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

export function mapActiveRunRow(
  row: RunListRow,
  timing: RunTimingRow | undefined,
): RunSummaryRow {
  const hasRun = row.run_id !== null
  const runId = row.run_id ?? `issue:${row.repo}#${row.issue_number}`

  return {
    runId,
    hasRun,
    repo: row.repo,
    issue: row.issue_number,
    status: row.status,
    issueTitle: row.issue_title,
    prNumber: row.pr_number,
    phase: row.current_phase,
    iterations: row.iteration_count ?? 0,
    costUsd: row.estimated_cost_usd ?? 0,
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    lastError: row.last_error,
    startedAt: hasRun ? timing?.started_at ?? null : null,
    endedAt: hasRun ? timing?.ended_at ?? null : null,
  }
}

export function mapInboxIssueRow(
  row: InboxIssueRow,
  triage: InboxTriage,
  commandHints: InboxCommandHints,
): InboxItemRow {
  return {
    runId: row.run_id ?? `issue:${row.repo}#${row.issue_number}`,
    repo: row.repo,
    issue: row.issue_number,
    issueTitle: row.issue_title,
    status: row.status,
    triage,
    phase: row.current_phase,
    iterations: row.iteration_count ?? 0,
    costUsd: row.estimated_cost_usd ?? 0,
    prNumber: row.pr_number,
    prTitle: row.pr_title,
    blockReason: row.block_reason,
    lastError: row.last_error,
    reason: row.block_reason ?? row.last_error,
    manualState: coerceManualState(row.manual_state),
    operationIntent: coerceOperationIntent(row.operation_intent),
    recommendedCommand: commandHints.recommendedCommand,
    availableCommands: commandHints.availableCommands,
    updatedAt: row.updated_at,
  }
}

export function countInboxTriages(items: InboxItemRow[]): Record<InboxTriage, number> {
  const counts: Record<InboxTriage, number> = {
    needs_human: 0,
    review_ready: 0,
    blocked: 0,
    error: 0,
  }

  for (const item of items) {
    counts[item.triage] += 1
  }

  return counts
}

export function sortInboxItems(items: InboxItemRow[]): InboxItemRow[] {
  const sorted = items.slice()
  sorted.sort((a, b) => {
    const triageDelta = INBOX_TRIAGE_SORT_ORDER[a.triage] - INBOX_TRIAGE_SORT_ORDER[b.triage]
    if (triageDelta !== 0) return triageDelta
    const updatedDelta = parseSortableTs(b.updatedAt) - parseSortableTs(a.updatedAt)
    if (updatedDelta !== 0) return updatedDelta
    return b.issue - a.issue
  })
  return sorted
}

function parseSortableTs(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY
  const parsed = parseUtcTimestampMs(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}
