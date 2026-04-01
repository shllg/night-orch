import React from 'react'
import { Box, Text } from 'ink'
import type { TuiStatsSnapshot } from '../../state/stats.js'
import { EVENT_COLORS, STATUS_COLORS } from './constants.js'
import type { AgentEventRow, IssueListRow, MergeBatchRow, RunListRow } from './data.js'
import { formatEventSummary, formatPrList, formatTime, truncate } from './format.js'
import { resolveIssueTitle, resolvePrTitle, type TitleLookup } from './titles.js'
import type { RunsViewMode } from './types.js'
import { partitionRowsByActivity, sliceWindow } from './view-model.js'

interface RunsViewProps {
  issues: IssueListRow[]
  selectedIndex: number
  selectedIssue: IssueListRow | null
  selectedRun: RunListRow | null
  selectedRunEvents: AgentEventRow[]
  mergeBatches: MergeBatchRow[]
  stats: TuiStatsSnapshot
  titleLookup: TitleLookup
  mode: RunsViewMode
  maxVisibleRuns: number
  eventScrollOffset: number
  eventWindowSize: number
}

export function RunsView({
  issues,
  selectedIndex,
  selectedIssue,
  selectedRun,
  selectedRunEvents,
  mergeBatches,
  stats,
  titleLookup,
  mode,
  maxVisibleRuns,
  eventScrollOffset,
  eventWindowSize,
}: RunsViewProps): React.ReactElement {
  if (mode === 'focus') {
    return (
      <FocusedIssueView
        selectedIssue={selectedIssue}
        selectedRun={selectedRun}
        selectedRunEvents={selectedRunEvents}
        titleLookup={titleLookup}
        stats={stats}
        mergeBatches={mergeBatches}
        eventScrollOffset={eventScrollOffset}
        eventWindowSize={eventWindowSize}
      />
    )
  }

  const allSections = partitionRowsByActivity(issues)
  const issueIndexByKey = new Map(issues.map((issue, index) => [issue.key, index]))
  const selectedRecentIndex = selectedIssue
    ? allSections.recent.findIndex((issue) => issue.key === selectedIssue.key)
    : -1
  const fallbackRecentIndex = Math.max(0, selectedIndex - allSections.active.length)
  const recentWindowSize = Math.max(1, maxVisibleRuns - allSections.active.length)
  const recentWindow = sliceWindow(
    allSections.recent,
    selectedRecentIndex >= 0 ? selectedRecentIndex : fallbackRecentIndex,
    recentWindowSize,
  )

  const renderIssueRow = (issue: IssueListRow, dimmed: boolean): React.ReactElement => {
    const selected = selectedIssue?.key === issue.key
    const issueTitle = resolveIssueTitle(issue, titleLookup) ?? '(title unavailable)'
    const statusColor = STATUS_COLORS[issue.status] ?? 'white'
    const absoluteIndex = issueIndexByKey.get(issue.key) ?? 0
    const runStatuses = issue.runs.slice(0, 3).map((run) => run.status).join(' -> ')

    return (
      <Box key={issue.key} flexDirection="column">
        <Text>
          <Text color={selected ? 'cyan' : 'gray'}>{selected ? '▶' : ' '}</Text>
          {' '}
          <Text dimColor={dimmed}>
            <Text color="gray">{String(absoluteIndex + 1).padStart(2, '0')}</Text>
            {' '}
            <Text color={statusColor}>{issue.status.padEnd(11)}</Text>
            {' '}
            <Text>{issue.repo}#{issue.issue_number}</Text>
            {'  '}
            <Text>{truncate(issueTitle, 56)}</Text>
          </Text>
        </Text>
        <Text dimColor color={dimmed ? 'gray' : undefined}>
          {'    '}
          <Text>runs {issue.runs.length}</Text>
          {'  '}
          <Text>history {truncate(runStatuses || '-', 44)}</Text>
          {'  '}
          <Text>{formatTime(issue.updated_at)}</Text>
        </Text>
      </Box>
    )
  }

  return (
    <>
      <Box marginBottom={1}>
        <Box width="72%" flexDirection="column" marginRight={1}>
          <Text bold>Issues ({issues.length})</Text>
          {issues.length === 0 && <Text color="gray">  No unresolved issues found</Text>}
          {issues.length > 0 && (
            <>
              <Text bold color="cyan">Active ({allSections.active.length})</Text>
              {allSections.active.length === 0 && <Text color="gray">  No active issues</Text>}
              {allSections.active.map((issue) => renderIssueRow(issue, false))}

              <Text bold color="gray">Recent ({allSections.recent.length})</Text>
              {allSections.recent.length === 0 && <Text color="gray">  No recent issues</Text>}
              {recentWindow.rows.map((issue) => renderIssueRow(issue, true))}
            </>
          )}
          {allSections.recent.length > recentWindow.rows.length && (
            <Text color="gray">
              {'  '}
              showing recent {recentWindow.start + 1}-{recentWindow.start + recentWindow.rows.length} of {allSections.recent.length}
            </Text>
          )}
        </Box>

        <Box width="28%" flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="cyan">Issue Preview</Text>
          {!selectedIssue && <Text color="gray">Select an issue to inspect</Text>}
          {selectedIssue && (
            <>
              <Text>{selectedIssue.repo}#{selectedIssue.issue_number}</Text>
              <Text color={STATUS_COLORS[selectedIssue.status] ?? 'white'}>{selectedIssue.status}</Text>
              <Text>{truncate(resolveIssueTitle(selectedIssue, titleLookup) ?? '(title unavailable)', 46)}</Text>
              {selectedIssue.pr_number !== null && (
                <Text dimColor>PR #{selectedIssue.pr_number}: {truncate(resolvePrTitle(selectedIssue, titleLookup) ?? '(title unavailable)', 36)}</Text>
              )}

              <Box marginTop={1} flexDirection="column">
                <Text bold>Runs</Text>
                {selectedIssue.runs.slice(0, 5).map((run) => (
                  <Text key={run.id}>
                    <Text color={STATUS_COLORS[run.status] ?? 'white'}>{truncate(run.status, 11)}</Text>
                    {' '}
                    <Text color="gray">{formatTime(run.updated_at)}</Text>
                    {' '}
                    <Text>{run.pr_number !== null ? `PR #${run.pr_number}` : 'no PR'}</Text>
                  </Text>
                ))}
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text bold>Log Glimpse</Text>
                {selectedRunEvents.length === 0 && <Text color="gray">No agent events yet</Text>}
                {selectedRunEvents.slice(-5).map((event) => {
                  const color = EVENT_COLORS[event.event_type] ?? 'gray'
                  return (
                    <Text key={event.id}>
                      <Text color="gray">{formatTime(event.created_at)}</Text>
                      {' '}
                      <Text color={color}>{truncate(event.event_type, 10)}</Text>
                      {' '}
                      <Text>{truncate(formatEventSummary(event), 22)}</Text>
                    </Text>
                  )
                })}
              </Box>

              <Text color="gray">Press o or Enter for expanded view</Text>
            </>
          )}
        </Box>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text bold>System Snapshot</Text>
        <Text dimColor>
          {'  '}active {stats.overview.activeRuns}  running {stats.overview.runningRuns}  queued {stats.overview.queuedRuns}  merge queue {mergeBatches.length}
        </Text>
        {mergeBatches.slice(0, 3).map((batch) => (
          <Text key={batch.id}>
            {'  '}
            <Text color="cyan">{batch.status}</Text>
            {' '}
            <Text>{batch.repo}</Text>
            {' PRs '}
            <Text>{formatPrList(batch.pr_numbers)}</Text>
          </Text>
        ))}
      </Box>
    </>
  )
}

interface FocusedIssueViewProps {
  selectedIssue: IssueListRow | null
  selectedRun: RunListRow | null
  selectedRunEvents: AgentEventRow[]
  titleLookup: TitleLookup
  stats: TuiStatsSnapshot
  mergeBatches: MergeBatchRow[]
  eventScrollOffset: number
  eventWindowSize: number
}

function FocusedIssueView({
  selectedIssue,
  selectedRun,
  selectedRunEvents,
  titleLookup,
  stats,
  mergeBatches,
  eventScrollOffset,
  eventWindowSize,
}: FocusedIssueViewProps): React.ReactElement {
  const maxEventOffset = Math.max(0, selectedRunEvents.length - eventWindowSize)
  const clampedOffset = Math.max(0, Math.min(maxEventOffset, eventScrollOffset))
  const visibleEvents = selectedRunEvents.slice(clampedOffset, clampedOffset + eventWindowSize)

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold>Issue Detail</Text>
      {!selectedIssue && <Text color="gray">No issue selected</Text>}
      {selectedIssue && (
        <>
          <Box>
            <Box width="35%" flexDirection="column" marginRight={1} borderStyle="single" borderColor="gray" paddingX={1}>
              <Text bold color="cyan">Overview</Text>
              <Text>{selectedIssue.repo}#{selectedIssue.issue_number}</Text>
              <Text color={STATUS_COLORS[selectedIssue.status] ?? 'white'}>{selectedIssue.status}</Text>
              <Text>{resolveIssueTitle(selectedIssue, titleLookup) ?? '(title unavailable)'}</Text>
              {selectedIssue.pr_number !== null && (
                <Text dimColor>PR #{selectedIssue.pr_number}: {resolvePrTitle(selectedIssue, titleLookup) ?? '(title unavailable)'}</Text>
              )}
              <Text>phase {selectedIssue.current_phase ?? '-'}</Text>
              <Text>iter {selectedIssue.iteration_count ?? 0}  cost ${(selectedIssue.estimated_cost_usd ?? 0).toFixed(2)}</Text>
              <Text dimColor>updated {formatTime(selectedIssue.updated_at)}</Text>
              {selectedIssue.last_error && <Text color="red">error: {truncate(selectedIssue.last_error, 90)}</Text>}
              <Box marginTop={1} flexDirection="column">
                <Text bold>Runs ({selectedIssue.runs.length})</Text>
                {selectedIssue.runs.slice(0, 10).map((run) => (
                  <Text key={run.id}>
                    <Text color={STATUS_COLORS[run.status] ?? 'white'}>{truncate(run.status, 11)}</Text>
                    {' '}
                    <Text color="gray">{formatTime(run.updated_at)}</Text>
                    {' '}
                    <Text>{run.id.slice(0, 12)}</Text>
                  </Text>
                ))}
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text bold>System</Text>
                <Text>active runs {stats.overview.activeRuns}</Text>
                <Text>merge queue {mergeBatches.length}</Text>
              </Box>
            </Box>

            <Box width="65%" flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
              <Text bold color="cyan">Agent Stream ({selectedRunEvents.length})</Text>
              {!selectedRun && <Text color="gray">No run available for this issue</Text>}
              {selectedRun && (
                <Text dimColor>
                  source run {selectedRun.id} ({selectedRun.status})
                </Text>
              )}
              {selectedRunEvents.length === 0 && <Text color="gray">No agent events</Text>}
              {visibleEvents.map((event) => {
                const color = EVENT_COLORS[event.event_type] ?? 'gray'
                return (
                  <Text key={event.id}>
                    <Text color="gray">[{formatTime(event.created_at)}]</Text>
                    {' '}
                    <Text color="gray">{event.role}</Text>
                    {' '}
                    <Text color={color}>{event.event_type}</Text>
                    {' '}
                    <Text>{formatEventSummary(event)}</Text>
                  </Text>
                )
              })}
              {selectedRunEvents.length > eventWindowSize && (
                <Text color="gray">
                  showing {clampedOffset + 1}-{clampedOffset + visibleEvents.length} of {selectedRunEvents.length}
                </Text>
              )}
            </Box>
          </Box>
          <Text color="gray">Press j/k to scroll stream, esc or q to close detail</Text>
        </>
      )}
    </Box>
  )
}
