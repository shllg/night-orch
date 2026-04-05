import React from 'react'
import { Box, Text } from 'ink'
import type { TuiStatsSnapshot } from '../../state/stats.js'
import {
  EVENT_COLORS,
  colorForCostUsd,
  colorForIterationCount,
  colorForPhase,
  colorForPrNumber,
  colorForRunStatus,
} from './constants.js'
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
    const statusColor = colorForRunStatus(issue.status)
    const absoluteIndex = issueIndexByKey.get(issue.key) ?? 0

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
        <Text dimColor={dimmed}>
          {'    '}
          <Text color="gray">phase </Text>
          <Text color={colorForPhase(issue.current_phase)}>{truncate(issue.current_phase ?? '-', 12)}</Text>
          {'  '}
          <Text color="gray">iter </Text>
          <Text color={colorForIterationCount(issue.iteration_count)}>{issue.iteration_count ?? 0}</Text>
          {'  '}
          <Text color="gray">cost </Text>
          <Text color={colorForCostUsd(issue.estimated_cost_usd)}>${(issue.estimated_cost_usd ?? 0).toFixed(2)}</Text>
          {'  '}
          <Text color={colorForPrNumber(issue.pr_number)}>{issue.pr_number !== null ? `PR #${issue.pr_number}` : 'no PR'}</Text>
          {'  '}
          <Text color="gray">runs {issue.runs.length} hist </Text>
          <RunHistory runs={issue.runs} maxItems={3} maxStatusLength={10} />
          {'  '}
          <Text color="gray">{formatTime(issue.updated_at)}</Text>
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
              <Text color={colorForRunStatus(selectedIssue.status)}>{selectedIssue.status}</Text>
              <Text>{truncate(resolveIssueTitle(selectedIssue, titleLookup) ?? '(title unavailable)', 46)}</Text>
              <Text>
                <Text color="gray">phase </Text>
                <Text color={colorForPhase(selectedIssue.current_phase)}>{truncate(selectedIssue.current_phase ?? '-', 10)}</Text>
                {'  '}
                <Text color="gray">iter </Text>
                <Text color={colorForIterationCount(selectedIssue.iteration_count)}>{selectedIssue.iteration_count ?? 0}</Text>
                {'  '}
                <Text color="gray">cost </Text>
                <Text color={colorForCostUsd(selectedIssue.estimated_cost_usd)}>${(selectedIssue.estimated_cost_usd ?? 0).toFixed(2)}</Text>
              </Text>
              {selectedIssue.pr_number !== null && (
                <Text dimColor>
                  <Text color={colorForPrNumber(selectedIssue.pr_number)}>PR #{selectedIssue.pr_number}</Text>
                  {`: ${truncate(resolvePrTitle(selectedIssue, titleLookup) ?? '(title unavailable)', 36)}`}
                </Text>
              )}

              <Box marginTop={1} flexDirection="column">
                <Text bold>Runs</Text>
                {selectedIssue.runs.slice(0, 5).map((run) => (
                  <Text key={run.id}>
                    <Text color={colorForRunStatus(run.status)}>{truncate(run.status, 11)}</Text>
                    {' '}
                    <Text color={colorForPhase(run.current_phase)}>{truncate(run.current_phase ?? '-', 8)}</Text>
                    {' '}
                    <Text color={colorForIterationCount(run.iteration_count)}>i{run.iteration_count ?? 0}</Text>
                    {' '}
                    <Text color={colorForCostUsd(run.estimated_cost_usd)}>${(run.estimated_cost_usd ?? 0).toFixed(2)}</Text>
                    {' '}
                    <Text color="gray">{formatTime(run.updated_at)}</Text>
                    {' '}
                    <Text color={colorForPrNumber(run.pr_number)}>{run.pr_number !== null ? `PR #${run.pr_number}` : 'no PR'}</Text>
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
              <Text color={colorForRunStatus(selectedIssue.status)}>{selectedIssue.status}</Text>
              <Text>{resolveIssueTitle(selectedIssue, titleLookup) ?? '(title unavailable)'}</Text>
              {selectedIssue.pr_number !== null && (
                <Text dimColor>
                  <Text color={colorForPrNumber(selectedIssue.pr_number)}>PR #{selectedIssue.pr_number}</Text>
                  {`: ${resolvePrTitle(selectedIssue, titleLookup) ?? '(title unavailable)'}`}
                </Text>
              )}
              <Text>
                <Text color="gray">phase </Text>
                <Text color={colorForPhase(selectedIssue.current_phase)}>{selectedIssue.current_phase ?? '-'}</Text>
              </Text>
              <Text>
                <Text color="gray">iter </Text>
                <Text color={colorForIterationCount(selectedIssue.iteration_count)}>{selectedIssue.iteration_count ?? 0}</Text>
                {'  '}
                <Text color="gray">cost </Text>
                <Text color={colorForCostUsd(selectedIssue.estimated_cost_usd)}>${(selectedIssue.estimated_cost_usd ?? 0).toFixed(2)}</Text>
              </Text>
              <Text dimColor>updated {formatTime(selectedIssue.updated_at)}</Text>
              {selectedIssue.last_error && <Text color="red">error: {truncate(selectedIssue.last_error, 500)}</Text>}
              <Box marginTop={1} flexDirection="column">
                <Text bold>Runs ({selectedIssue.runs.length})</Text>
                {selectedIssue.runs.slice(0, 10).map((run) => (
                  <Text key={run.id}>
                    <Text color={colorForRunStatus(run.status)}>{truncate(run.status, 10)}</Text>
                    {' '}
                    <Text color={colorForPhase(run.current_phase)}>{truncate(run.current_phase ?? '-', 8)}</Text>
                    {' '}
                    <Text color={colorForIterationCount(run.iteration_count)}>i{run.iteration_count ?? 0}</Text>
                    {' '}
                    <Text color={colorForCostUsd(run.estimated_cost_usd)}>${(run.estimated_cost_usd ?? 0).toFixed(2)}</Text>
                    {' '}
                    <Text color={colorForPrNumber(run.pr_number)}>{run.pr_number !== null ? `PR #${run.pr_number}` : 'no PR'}</Text>
                    {' '}
                    <Text color="gray">{formatTime(run.updated_at)}</Text>
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
                  source run {selectedRun.id}
                  {'  '}
                  <Text color={colorForRunStatus(selectedRun.status)}>{selectedRun.status}</Text>
                  {'  '}
                  <Text color={colorForPhase(selectedRun.current_phase)}>{selectedRun.current_phase ?? '-'}</Text>
                  {'  '}
                  <Text color={colorForIterationCount(selectedRun.iteration_count)}>i{selectedRun.iteration_count ?? 0}</Text>
                  {'  '}
                  <Text color={colorForCostUsd(selectedRun.estimated_cost_usd)}>${(selectedRun.estimated_cost_usd ?? 0).toFixed(2)}</Text>
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

interface RunHistoryProps {
  runs: RunListRow[]
  maxItems: number
  maxStatusLength: number
}

function RunHistory({ runs, maxItems, maxStatusLength }: RunHistoryProps): React.ReactElement {
  const history = runs.slice(0, maxItems)
  if (history.length === 0) {
    return <Text color="gray">-</Text>
  }

  return (
    <>
      {history.map((run, index) => (
        <React.Fragment key={run.id}>
          {index > 0 && <Text color="gray">→</Text>}
          <Text color={colorForRunStatus(run.status)}>{truncate(run.status, maxStatusLength)}</Text>
        </React.Fragment>
      ))}
    </>
  )
}
