import React from 'react'
import { Box, Text } from 'ink'
import type { TuiStatsSnapshot } from '../../state/stats.js'
import { EVENT_COLORS, STATUS_COLORS } from './constants.js'
import type { AgentEventRow, MergeBatchRow, RunListRow } from './data.js'
import { formatEventSummary, formatPrList, formatTime, truncate } from './format.js'
import { resolveIssueTitle, resolvePrTitle, type TitleLookup } from './titles.js'
import type { RunsViewMode } from './types.js'
import { sliceWindow } from './view-model.js'

interface RunsViewProps {
  runs: RunListRow[]
  selectedIndex: number
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
  runs,
  selectedIndex,
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
      <FocusedRunView
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

  const windowed = sliceWindow(runs, selectedIndex, maxVisibleRuns)

  return (
    <>
      <Box marginBottom={1}>
        <Box width="72%" flexDirection="column" marginRight={1}>
          <Text bold>Runs ({runs.length})</Text>
          {runs.length === 0 && <Text color="gray">  No runs found</Text>}
          {windowed.rows.map((run, idx) => {
            const absoluteIndex = windowed.start + idx
            const selected = selectedRun?.id === run.id
            const issueTitle = resolveIssueTitle(run, titleLookup) ?? '(title unavailable)'
            const prTitle = resolvePrTitle(run, titleLookup)
            const statusColor = STATUS_COLORS[run.status] ?? 'white'

            return (
              <Box key={run.id} flexDirection="column">
                <Text>
                  <Text color={selected ? 'cyan' : 'gray'}>{selected ? '▶' : ' '}</Text>
                  {' '}
                  <Text color="gray">{String(absoluteIndex + 1).padStart(2, '0')}</Text>
                  {' '}
                  <Text color={statusColor}>{run.status.padEnd(11)}</Text>
                  {' '}
                  <Text>{run.repo}#{run.issue_number}</Text>
                  {'  '}
                  <Text>{truncate(issueTitle, 58)}</Text>
                </Text>
                <Text color="gray">
                  {'    '}
                  <Text>{run.pr_number !== null ? `PR #${run.pr_number} ${truncate(prTitle ?? '(title unavailable)', 40)}` : 'No PR yet'}</Text>
                  {'  '}
                  <Text>phase {run.current_phase ?? '-'}</Text>
                  {'  '}
                  <Text>iter {run.iteration_count ?? 0}</Text>
                  {'  '}
                  <Text>cost ${(run.estimated_cost_usd ?? 0).toFixed(2)}</Text>
                  {'  '}
                  <Text>{formatTime(run.updated_at)}</Text>
                </Text>
              </Box>
            )
          })}
          {runs.length > windowed.rows.length && (
            <Text color="gray">  showing {windowed.start + 1}-{windowed.start + windowed.rows.length} of {runs.length}</Text>
          )}
        </Box>

        <Box width="28%" flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="cyan">Issue Preview</Text>
          {!selectedRun && <Text color="gray">Select a run to inspect</Text>}
          {selectedRun && (
            <>
              <Text>{selectedRun.repo}#{selectedRun.issue_number}</Text>
              <Text color={STATUS_COLORS[selectedRun.status] ?? 'white'}>{selectedRun.status}</Text>
              <Text>{truncate(resolveIssueTitle(selectedRun, titleLookup) ?? '(title unavailable)', 46)}</Text>
              {selectedRun.pr_number !== null && (
                <Text color="gray">PR #{selectedRun.pr_number}: {truncate(resolvePrTitle(selectedRun, titleLookup) ?? '(title unavailable)', 36)}</Text>
              )}

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
        <Text color="gray">
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

interface FocusedRunViewProps {
  selectedRun: RunListRow | null
  selectedRunEvents: AgentEventRow[]
  titleLookup: TitleLookup
  stats: TuiStatsSnapshot
  mergeBatches: MergeBatchRow[]
  eventScrollOffset: number
  eventWindowSize: number
}

function FocusedRunView({
  selectedRun,
  selectedRunEvents,
  titleLookup,
  stats,
  mergeBatches,
  eventScrollOffset,
  eventWindowSize,
}: FocusedRunViewProps): React.ReactElement {
  const maxEventOffset = Math.max(0, selectedRunEvents.length - eventWindowSize)
  const clampedOffset = Math.max(0, Math.min(maxEventOffset, eventScrollOffset))
  const visibleEvents = selectedRunEvents.slice(clampedOffset, clampedOffset + eventWindowSize)

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold>Run Detail</Text>
      {!selectedRun && <Text color="gray">No run selected</Text>}
      {selectedRun && (
        <>
          <Box>
            <Box width="35%" flexDirection="column" marginRight={1} borderStyle="single" borderColor="gray" paddingX={1}>
              <Text bold color="cyan">Overview</Text>
              <Text>{selectedRun.repo}#{selectedRun.issue_number}</Text>
              <Text color={STATUS_COLORS[selectedRun.status] ?? 'white'}>{selectedRun.status}</Text>
              <Text>{resolveIssueTitle(selectedRun, titleLookup) ?? '(title unavailable)'}</Text>
              {selectedRun.pr_number !== null && (
                <Text color="gray">PR #{selectedRun.pr_number}: {resolvePrTitle(selectedRun, titleLookup) ?? '(title unavailable)'}</Text>
              )}
              <Text color="gray">phase {selectedRun.current_phase ?? '-'}</Text>
              <Text color="gray">iter {selectedRun.iteration_count ?? 0}  cost ${(selectedRun.estimated_cost_usd ?? 0).toFixed(2)}</Text>
              <Text color="gray">updated {formatTime(selectedRun.updated_at)}</Text>
              {selectedRun.last_error && <Text color="red">error: {truncate(selectedRun.last_error, 90)}</Text>}
              <Box marginTop={1} flexDirection="column">
                <Text bold>System</Text>
                <Text color="gray">active runs {stats.overview.activeRuns}</Text>
                <Text color="gray">merge queue {mergeBatches.length}</Text>
              </Box>
            </Box>

            <Box width="65%" flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
              <Text bold color="cyan">Agent Stream ({selectedRunEvents.length})</Text>
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
