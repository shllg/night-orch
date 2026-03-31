import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { Config } from '../../config/schema.js'
import { RetryEngine } from '../../ops/retry.js'
import { SyncEngine } from '../../ops/sync.js'
import { CleanupEngine } from '../../ops/cleanup.js'
import { pollOnce } from '../../runner/poller.js'
import { queueRebase } from '../../ops/rebase-and-check.js'
import { createForgeAdapter } from '../../forge/factory.js'
import type Database from 'better-sqlite3'
import { loadTuiStats, type StatusAggregate, type TuiStatsSnapshot } from '../../state/stats.js'
import { ActionsBar } from './actions-bar.js'

interface AppProps {
  db: Database.Database
  config: Config
  pollIntervalMs?: number
  dryRun?: boolean
}

interface RunListRow {
  id: string
  repo: string
  issue_number: number
  status: string
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  last_error: string | null
  updated_at: string
}

interface AgentEventRow {
  id: number
  run_id: string
  role: string
  event_type: string
  data: string | null
  created_at: string
}

interface MergeBatchRow {
  id: string
  repo: string
  status: string
  pr_numbers: string
}

interface ActionState {
  busy: boolean
  action: string | null
}

type TabId = 'runs' | 'stats'

const TABS: Array<{ id: TabId; hotkey: string; label: string }> = [
  { id: 'runs', hotkey: '1', label: 'Runs' },
  { id: 'stats', hotkey: '2', label: 'Stats' },
]

const STATUS_COLORS: Record<string, 'white' | 'yellow' | 'cyan' | 'magenta' | 'green' | 'red'> = {
  running: 'yellow',
  queued: 'cyan',
  review_ready: 'magenta',
  completed: 'green',
  blocked: 'red',
  error: 'red',
}

const EVENT_COLORS: Record<string, 'gray' | 'cyan' | 'green' | 'yellow' | 'red' | 'magenta'> = {
  session_start: 'green',
  session_end: 'green',
  text: 'gray',
  tool_call: 'cyan',
  tool_result: 'magenta',
  thinking: 'yellow',
  turn_complete: 'yellow',
  error: 'red',
}

export function App({ db, config, pollIntervalMs = 2000, dryRun = false }: AppProps): React.ReactElement {
  const { exit } = useApp()
  const [tick, setTick] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState('Ready')
  const [actionState, setActionState] = useState<ActionState>({ busy: false, action: null })
  const [activeTab, setActiveTab] = useState<TabId>('runs')

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), pollIntervalMs)
    return () => clearInterval(timer)
  }, [pollIntervalMs])

  const runs = useMemo(() => loadRuns(db), [db, tick])
  const selectedIndex = runs.findIndex((run) => run.id === selectedRunId)
  const selectedRun = selectedIndex >= 0 ? (runs[selectedIndex] ?? null) : (runs[0] ?? null)
  const selectedRunEvents = useMemo(
    () => (selectedRun ? loadAgentEvents(db, selectedRun.id, 12) : []),
    [db, tick, selectedRun?.id],
  )
  const mergeBatches = useMemo(() => loadMergeBatches(db), [db, tick])
  const stats = useMemo(() => loadTuiStats(db), [db, tick])

  useEffect(() => {
    if (runs.length === 0) {
      if (selectedRunId !== null) setSelectedRunId(null)
      return
    }
    if (!selectedRunId || !runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(runs[0]!.id)
    }
  }, [runs, selectedRunId])

  const moveSelection = useCallback((direction: -1 | 1) => {
    if (runs.length === 0) return

    const currentIndex = selectedRun
      ? runs.findIndex((run) => run.id === selectedRun.id)
      : 0
    const nextIndex = Math.max(0, Math.min(runs.length - 1, currentIndex + direction))
    const nextRun = runs[nextIndex]
    if (nextRun) {
      setSelectedRunId(nextRun.id)
    }
  }, [runs, selectedRun])

  const switchTab = useCallback((direction: -1 | 1) => {
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab)
    const nextIndex = Math.max(0, Math.min(TABS.length - 1, currentIndex + direction))
    const next = TABS[nextIndex]
    if (next) setActiveTab(next.id)
  }, [activeTab])

  const forceRefresh = useCallback(() => {
    setTick((t) => t + 1)
    setStatusLine(`Refreshed at ${new Date().toISOString().slice(11, 19)}`)
  }, [])

  const runAction = useCallback(async (
    actionName: string,
    actionFn: () => Promise<string>,
  ) => {
    if (actionState.busy) return
    setActionState({ busy: true, action: actionName })
    setStatusLine(`Running ${actionName}...`)
    try {
      const result = await actionFn()
      setStatusLine(`${actionName}: ${result}`)
    } catch (err) {
      setStatusLine(`${actionName} failed: ${(err as Error).message}`)
    } finally {
      setActionState({ busy: false, action: null })
      setTick((t) => t + 1)
    }
  }, [actionState.busy])

  const runRetry = useCallback(async () => {
    await runAction('retry', async () => {
      if (!selectedRun) throw new Error('No run selected')
      const engine = new RetryEngine(db, config)
      await engine.retry(selectedRun.repo, selectedRun.issue_number, {
        immediate: false,
        resetPlan: false,
        dryRun,
      })
      return `queued ${selectedRun.repo}#${selectedRun.issue_number}${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, runAction, selectedRun])

  const runSync = useCallback(async () => {
    await runAction('sync', async () => {
      const engine = new SyncEngine(db, config)
      const result = await engine.reconcile(dryRun)
      return `${result.reconciledRuns.length} reconciled, ${result.labelCorrections.length} label fixes, ${result.expiredLeases} expired lease(s), ${result.orphanedWorktrees.length} orphaned worktree(s)${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, runAction])

  const runCleanup = useCallback(async () => {
    await runAction('cleanup', async () => {
      const engine = new CleanupEngine(db, config)
      const result = await engine.run({
        completedWorktrees: true,
        errorWorktreeAgeDays: 7,
        mergedBranches: false,
        logArchiveAgeDays: 30,
        dryRun,
      })
      const freed = result.freedDiskMb > 0 ? `, freed ${result.freedDiskMb.toFixed(1)} MB` : ''
      return `${result.removedWorktrees.length} worktree(s), ${result.removedBranches.length} branch(es), ${result.archivedLogs.length} log(s), ${result.expiredLeases} lease(s)${freed}${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, runAction])

  const runPoll = useCallback(async () => {
    await runAction('poll', async () => {
      const targetIssue = selectedRun
        ? { repo: selectedRun.repo, issueNumber: selectedRun.issue_number }
        : undefined
      const result = await pollOnce(config, db, dryRun, undefined, targetIssue)
      const targetSuffix = targetIssue ? ` for ${targetIssue.repo}#${targetIssue.issueNumber}` : ''
      return `${result.processed} processed, ${result.errors} error(s)${targetSuffix}${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, runAction, selectedRun])

  const runRebase = useCallback(async () => {
    await runAction('rebase', async () => {
      const target = selectedRun ?? runs.find((r) => r.status === 'review_ready')
      if (!target) throw new Error('No run selected')
      const repoConfig = config.repos.find((r) => r.repo === target.repo)
      if (!repoConfig) throw new Error(`Repo not found in config: ${target.repo}`)
      const forge = createForgeAdapter(repoConfig, config)
      let botUser = ''
      try {
        const auth = await forge.validateAuth()
        botUser = auth.user
      } catch { /* best effort */ }
      const result = await queueRebase(db, forge, repoConfig, target.issue_number, botUser)
      return `${target.repo}#${target.issue_number}: ${result.reason}`
    })
  }, [config, db, runAction, runs, selectedRun])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()
      return
    }
    if (input === 'q') {
      exit()
      return
    }

    if (input === '1') {
      setActiveTab('runs')
      return
    }
    if (input === '2') {
      setActiveTab('stats')
      return
    }
    if (key.rightArrow || input === 'l') {
      switchTab(1)
      return
    }
    if (key.leftArrow || input === 'h') {
      switchTab(-1)
      return
    }

    if (activeTab === 'runs') {
      if (key.downArrow || input === 'j') {
        moveSelection(1)
        return
      }
      if (key.upArrow || input === 'k') {
        moveSelection(-1)
        return
      }
    }

    if (input === 'f') {
      forceRefresh()
      return
    }

    if (actionState.busy) {
      return
    }
    if (input === 'r') {
      void runRetry()
      return
    }
    if (input === 'b') {
      void runRebase()
      return
    }
    if (input === 's') {
      void runSync()
      return
    }
    if (input === 'c') {
      void runCleanup()
      return
    }
    if (input === 'p') {
      void runPoll()
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        pollIntervalMs={pollIntervalMs}
        dryRun={dryRun}
        status={stats}
      />

      <TabBar activeTab={activeTab} />

      <Box marginBottom={1}>
        <Text color={actionState.busy ? 'yellow' : 'gray'}>
          {actionState.busy ? `busy: ${actionState.action ?? 'action'}` : statusLine}
        </Text>
      </Box>

      {activeTab === 'runs'
        ? (
            <RunsView
              runs={runs}
              selectedRun={selectedRun}
              selectedRunEvents={selectedRunEvents}
              mergeBatches={mergeBatches}
              stats={stats}
            />
          )
        : (
            <StatsView stats={stats} />
          )}

      <ActionsBar activeTab={activeTab} busy={actionState.busy} />
    </Box>
  )
}

interface HeaderProps {
  pollIntervalMs: number
  dryRun: boolean
  status: TuiStatsSnapshot
}

function Header({ pollIntervalMs, dryRun, status }: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">night-orch monitor</Text>
        <Text color="gray">  refresh {pollIntervalMs / 1000}s</Text>
        {dryRun && <Text color="yellow">  [dry-run]</Text>}
        <Text color="gray">  updated {formatTime(status.updatedAt)}</Text>
      </Box>
      <Text color="gray">
        runs {status.overview.totalRuns}  active {status.overview.activeRuns}  queued {status.overview.queuedRuns}  daily cost ${status.cost.todayCostUsd.toFixed(2)}
      </Text>
    </Box>
  )
}

interface TabBarProps {
  activeTab: TabId
}

function TabBar({ activeTab }: TabBarProps): React.ReactElement {
  return (
    <Box marginBottom={1}>
      {TABS.map((tab, index) => (
        <Box key={tab.id} marginRight={2}>
          <Text color={activeTab === tab.id ? 'cyan' : 'gray'}>
            {activeTab === tab.id ? '▸' : ' '}[{tab.hotkey}] {tab.label}
          </Text>
          {index < TABS.length - 1 && <Text color="gray"> </Text>}
        </Box>
      ))}
    </Box>
  )
}

interface RunsViewProps {
  runs: RunListRow[]
  selectedRun: RunListRow | null
  selectedRunEvents: AgentEventRow[]
  mergeBatches: MergeBatchRow[]
  stats: TuiStatsSnapshot
}

function RunsView({ runs, selectedRun, selectedRunEvents, mergeBatches, stats }: RunsViewProps): React.ReactElement {
  return (
    <>
      <Box marginBottom={1}>
        <Box flexDirection="column" width="42%">
          <Text bold>Runs ({runs.length})</Text>
          {runs.length === 0 && <Text color="gray">  No runs found</Text>}
          {runs.map((run, index) => {
            const selected = selectedRun?.id === run.id
            const marker = selected ? '>' : ' '
            const statusColor = STATUS_COLORS[run.status] ?? 'white'
            const idShort = run.id.replace('run-', '').slice(0, 8)
            return (
              <Text key={run.id}>
                <Text color={selected ? 'cyan' : 'gray'}>{marker}</Text>
                {' '}
                <Text color="gray">{String(index + 1).padStart(2, '0')}</Text>
                {' '}
                <Text color={statusColor}>{run.status.padEnd(11)}</Text>
                {' '}
                <Text>{run.repo}#{run.issue_number}</Text>
                {' '}
                <Text color="gray">{idShort}</Text>
              </Text>
            )
          })}
        </Box>

        <Box flexDirection="column" width="58%">
          <Text bold>Selected Run</Text>
          {!selectedRun && <Text color="gray">  Select a run to inspect</Text>}
          {selectedRun && (
            <>
              <Text>
                {'  '}
                <Text>{selectedRun.repo}#{selectedRun.issue_number}</Text>
                {'  '}
                <Text color={STATUS_COLORS[selectedRun.status] ?? 'white'}>{selectedRun.status}</Text>
              </Text>
              <Text color="gray">
                {'  '}phase {selectedRun.current_phase ?? '-'}  iter {selectedRun.iteration_count ?? 0}  cost ${(selectedRun.estimated_cost_usd ?? 0).toFixed(2)}
              </Text>
              <Text color="gray">
                {'  '}run {selectedRun.id}  updated {formatTime(selectedRun.updated_at)}
              </Text>
              {selectedRun.last_error && (
                <Text color="red">{'  '}last error: {truncate(selectedRun.last_error, 96)}</Text>
              )}

              <Box marginTop={1} flexDirection="column">
                <Text bold>Agent Stream</Text>
                {selectedRunEvents.length === 0 && <Text color="gray">  No agent events</Text>}
                {selectedRunEvents.map((event) => {
                  const color = EVENT_COLORS[event.event_type] ?? 'gray'
                  return (
                    <Text key={event.id}>
                      {'  '}
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
              </Box>
            </>
          )}
        </Box>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text bold>System</Text>
        <Text color="gray">
          {'  '}active {stats.overview.activeRuns}  daily cost ${stats.cost.todayCostUsd.toFixed(2)}  merge queue {mergeBatches.length}
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

interface StatsViewProps {
  stats: TuiStatsSnapshot
}

function StatsView({ stats }: StatsViewProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Overview</Text>
        <Text color="gray">
          {'  '}total {stats.overview.totalRuns}  active {stats.overview.activeRuns}  running {stats.overview.runningRuns}  queued {stats.overview.queuedRuns}
        </Text>
        <Text color="gray">
          {'  '}completed {stats.overview.completedRuns}  review_ready {stats.overview.reviewReadyRuns}  blocked {stats.overview.blockedRuns}  error {stats.overview.errorRuns}
        </Text>
        <Text color="gray">{'  '}status mix {formatStatusMix(stats.statusCounts)}</Text>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text bold>Throughput</Text>
        <Text color="gray">
          {'  '}runs 24h {stats.throughput.runs24h}  7d {stats.throughput.runs7d}  30d {stats.throughput.runs30d}
        </Text>
        <Text color="gray">
          {'  '}terminal 7d completed {stats.throughput.completed7d} blocked {stats.throughput.blocked7d} error {stats.throughput.error7d} success {stats.throughput.successRate7d.toFixed(1)}%
        </Text>
        <Text color="gray">
          {'  '}avg duration 7d {formatMinutes(stats.throughput.avgDurationMinutes7d)}  avg iterations 7d {stats.throughput.avgIterations7d.toFixed(2)}
        </Text>
        <Text color="gray">
          {'  '}active phases {stats.phaseCounts.length === 0 ? '-' : stats.phaseCounts.map((row) => `${row.phase}:${row.count}`).join('  ')}
        </Text>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text bold>Cost</Text>
        <Text color="gray">
          {'  '}today ${stats.cost.todayCostUsd.toFixed(2)} ({stats.cost.todayRunCount} runs)  7d ${stats.cost.cost7d.toFixed(2)}  30d ${stats.cost.cost30d.toFixed(2)}  avg/day ${stats.cost.avgDailyCost7d.toFixed(2)}
        </Text>
        {stats.cost.dailyHistory.length === 0 && <Text color="gray">  No daily cost history</Text>}
        {stats.cost.dailyHistory.slice().reverse().map((row) => (
          <Text key={row.date} color="gray">
            {'  '}
            <Text>{row.date}</Text>
            {'  '}
            <Text>${row.totalCostUsd.toFixed(2)}</Text>
            {'  '}
            <Text>{row.runCount} run(s)</Text>
          </Text>
        ))}
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text bold>Agent Activity</Text>
        <Text color="gray">
          {'  '}events total {stats.agents.eventsTotal}  24h {stats.agents.events24h}  7d {stats.agents.events7d}  runs 7d {stats.agents.uniqueRuns7d}
        </Text>
        <Text color="gray">
          {'  '}tool calls 24h {stats.agents.toolCalls24h}  thinking 24h {stats.agents.thinking24h}
        </Text>
        <Text color="gray">
          {'  '}role mix 7d {stats.agents.roleBreakdown7d.length === 0 ? '-' : stats.agents.roleBreakdown7d.map((row) => `${row.role}:${row.events}`).join('  ')}
        </Text>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text bold>Merge Queue</Text>
        <Text color="gray">
          {'  '}active batches {stats.queue.activeBatches}  statuses {stats.queue.statuses.length === 0 ? '-' : stats.queue.statuses.map((row) => `${row.status}:${row.count}`).join('  ')}
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text bold>Top Repos (30d)</Text>
        {stats.topRepos30d.length === 0 && <Text color="gray">  No run history</Text>}
        {stats.topRepos30d.map((row) => {
          const terminalCount = row.completedRuns + row.blockedRuns + row.errorRuns
          const successPct = terminalCount > 0 ? (row.completedRuns / terminalCount) * 100 : 0
          const errorPct = terminalCount > 0 ? (row.errorRuns / terminalCount) * 100 : 0
          return (
            <Text key={row.repo}>
              {'  '}
              <Text>{truncate(row.repo, 26)}</Text>
              {'  '}
              <Text color="gray">runs {row.totalRuns}</Text>
              {'  '}
              <Text color="green">ok {successPct.toFixed(0)}%</Text>
              {'  '}
              <Text color="red">err {errorPct.toFixed(0)}%</Text>
              {'  '}
              <Text color="gray">cost ${row.totalCostUsd.toFixed(2)}</Text>
              {'  '}
              <Text color="gray">iter {row.avgIterations.toFixed(1)}</Text>
            </Text>
          )
        })}
      </Box>
    </Box>
  )
}

function loadRuns(db: Database.Database): RunListRow[] {
  return db
    .prepare(
      `SELECT id, repo, issue_number, status, current_phase, iteration_count, estimated_cost_usd, last_error, updated_at
       FROM runs
       ORDER BY
         CASE status
           WHEN 'running' THEN 0
           WHEN 'queued' THEN 1
           WHEN 'review_ready' THEN 2
           WHEN 'blocked' THEN 3
           WHEN 'error' THEN 4
           ELSE 5
         END,
         datetime(updated_at) DESC
       LIMIT 24`,
    )
    .all() as RunListRow[]
}

function loadAgentEvents(db: Database.Database, runId: string, maxLines: number): AgentEventRow[] {
  const rows = db
    .prepare(
      `SELECT id, run_id, role, event_type, data, created_at
       FROM agent_events
       WHERE run_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(runId, maxLines) as AgentEventRow[]
  return [...rows].reverse()
}

function loadMergeBatches(db: Database.Database): MergeBatchRow[] {
  return db
    .prepare(
      `SELECT id, repo, status, pr_numbers
       FROM merge_batches
       WHERE status NOT IN ('passed', 'failed')
       ORDER BY created_at DESC
       LIMIT 5`,
    )
    .all() as MergeBatchRow[]
}

function formatStatusMix(statuses: StatusAggregate[]): string {
  if (statuses.length === 0) return '-'
  return statuses.map((row) => `${row.status}:${row.count}`).join('  ')
}

function formatEventSummary(event: AgentEventRow): string {
  const data = parseEventData(event.data)
  if (!data) return ''

  if (event.event_type === 'tool_call') {
    const toolName = asString(data['toolName']) ?? 'tool'
    const args = asString(data['toolArgs'])
    return truncate(args ? `${toolName} ${args}` : toolName)
  }
  if (event.event_type === 'text' || event.event_type === 'thinking') {
    return truncate(asString(data['text']) ?? '')
  }
  if (event.event_type === 'error') {
    return truncate(asString(data['error']) ?? '')
  }
  if (event.event_type === 'turn_complete' && typeof data['tokenCount'] === 'number') {
    return `${data['tokenCount']} tokens`
  }
  if (event.event_type === 'session_start' || event.event_type === 'session_end') {
    const sessionId = asString(data['sessionId'])
    return sessionId ? `session ${sessionId}` : ''
  }
  return truncate(JSON.stringify(data))
}

function parseEventData(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return { raw: value }
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function truncate(value: string, maxLen = 72): string {
  if (value.length <= maxLen) return value
  return `${value.slice(0, maxLen - 3)}...`
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toISOString().slice(11, 19)
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '-'
  if (minutes < 1) return `${Math.round(minutes * 60)}s`
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  const hours = Math.floor(minutes / 60)
  const mins = Math.round(minutes % 60)
  return `${hours}h${String(mins).padStart(2, '0')}m`
}

function formatPrList(prNumbersRaw: string): string {
  try {
    const parsed: unknown = JSON.parse(prNumbersRaw)
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value)).join(', ')
    }
    return '-'
  } catch {
    return '-'
  }
}
