import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
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
import { loadRuns, loadAgentEvents, loadMergeBatches, type AgentEventRow, type MergeBatchRow, type RunListRow } from './data.js'
import { collectMissingTitleTargets, hasReadableTitle, resolveIssueTitle, resolvePrTitle, type TitleLookup } from './titles.js'
import { buildSparkline, sliceWindow } from './view-model.js'

interface AppProps {
  db: Database.Database
  config: Config
  pollIntervalMs?: number
  dryRun?: boolean
}

interface ActionState {
  busy: boolean
  action: string | null
}

type TabId = 'runs' | 'stats'
type RunsViewMode = 'list' | 'focus'

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
  const [runsViewMode, setRunsViewMode] = useState<RunsViewMode>('list')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastRefreshAt, setLastRefreshAt] = useState(new Date().toISOString())
  const [titleLookup, setTitleLookup] = useState<TitleLookup>({ issues: {}, prs: {} })

  const attemptedIssueKeys = useRef<Set<string>>(new Set())
  const attemptedPrKeys = useRef<Set<string>>(new Set())
  const lastHydrationAt = useRef(0)

  const forgeByRepo = useMemo(() => {
    const map = new Map<string, ReturnType<typeof createForgeAdapter>>()
    for (const repoConfig of config.repos) {
      map.set(repoConfig.repo, createForgeAdapter(repoConfig, config))
    }
    return map
  }, [config])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => {
      setTick((t) => t + 1)
    }, pollIntervalMs)
    return () => clearInterval(timer)
  }, [autoRefresh, pollIntervalMs])

  useEffect(() => {
    setLastRefreshAt(new Date().toISOString())
  }, [tick])

  const runs = useMemo(() => loadRuns(db), [db, tick])
  const selectedIndex = runs.findIndex((run) => run.id === selectedRunId)
  const selectedRun = selectedIndex >= 0 ? (runs[selectedIndex] ?? null) : (runs[0] ?? null)
  const selectedRunEvents = useMemo(
    () => (selectedRun ? loadAgentEvents(db, selectedRun.id, runsViewMode === 'focus' ? 40 : 10) : []),
    [db, tick, selectedRun?.id, runsViewMode],
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

  useEffect(() => {
    const now = Date.now()
    if (now - lastHydrationAt.current < 3000) {
      return
    }

    const missing = collectMissingTitleTargets(
      runs,
      titleLookup,
      attemptedIssueKeys.current,
      attemptedPrKeys.current,
      6,
    )

    if (missing.issues.length === 0 && missing.prs.length === 0) {
      return
    }

    lastHydrationAt.current = now

    for (const issue of missing.issues) {
      attemptedIssueKeys.current.add(issue.key)
    }
    for (const pr of missing.prs) {
      attemptedPrKeys.current.add(pr.key)
    }

    void (async () => {
      const nextIssueTitles: Record<string, string> = {}
      const nextPrTitles: Record<string, string> = {}

      const updateIssueStmt = db.prepare(
        `UPDATE runs
         SET issue_title = ?
         WHERE repo = ?
           AND issue_number = ?
           AND (issue_title IS NULL OR TRIM(issue_title) = '')`,
      )
      const updatePrStmt = db.prepare(
        `UPDATE runs
         SET pr_title = ?
         WHERE repo = ?
           AND pr_number = ?
           AND (pr_title IS NULL OR TRIM(pr_title) = '')`,
      )

      for (const target of missing.issues) {
        const forge = forgeByRepo.get(target.repo)
        if (!forge) continue
        try {
          const issue = await forge.getIssue(target.repo, target.issueNumber)
          if (hasReadableTitle(issue.title)) {
            const title = issue.title.trim()
            nextIssueTitles[target.key] = title
            updateIssueStmt.run(title, target.repo, target.issueNumber)
          }
        } catch {
          // Best effort title hydration; keep previous UI value when unavailable.
        }
      }

      for (const target of missing.prs) {
        const forge = forgeByRepo.get(target.repo)
        if (!forge?.getPR) continue
        try {
          const pr = await forge.getPR(target.repo, target.prNumber)
          if (hasReadableTitle(pr.title)) {
            const title = pr.title.trim()
            nextPrTitles[target.key] = title
            updatePrStmt.run(title, target.repo, target.prNumber)
          }
        } catch {
          // Best effort title hydration; keep previous UI value when unavailable.
        }
      }

      if (Object.keys(nextIssueTitles).length === 0 && Object.keys(nextPrTitles).length === 0) {
        return
      }

      setTitleLookup((current) => ({
        issues: { ...current.issues, ...nextIssueTitles },
        prs: { ...current.prs, ...nextPrTitles },
      }))
      setTick((t) => t + 1)
    })()
  }, [db, forgeByRepo, runs, titleLookup])

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
      if (input === 'o' || key.return) {
        if (selectedRun) {
          setRunsViewMode((mode) => (mode === 'list' ? 'focus' : 'list'))
        }
        return
      }
      if (key.escape && runsViewMode === 'focus') {
        setRunsViewMode('list')
        return
      }
    }

    if (input === 'f') {
      forceRefresh()
      return
    }

    if (activeTab === 'stats' && input === 'a') {
      setAutoRefresh((current) => {
        const next = !current
        setStatusLine(next ? 'Auto-refresh enabled' : 'Auto-refresh paused')
        return next
      })
      return
    }

    if (actionState.busy) {
      return
    }

    if (activeTab !== 'runs') {
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

  const runsVisible = runsViewMode === 'focus' ? 8 : 10

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        activeTab={activeTab}
        pollIntervalMs={pollIntervalMs}
        dryRun={dryRun}
        status={stats}
        autoRefresh={autoRefresh}
        lastRefreshAt={lastRefreshAt}
      />

      <Box marginBottom={1}>
        <Text color={actionState.busy ? 'yellow' : 'gray'}>
          {actionState.busy ? `busy: ${actionState.action ?? 'action'}` : statusLine}
        </Text>
      </Box>

      {activeTab === 'runs'
        ? (
            <RunsView
              runs={runs}
              selectedIndex={selectedIndex < 0 ? 0 : selectedIndex}
              selectedRun={selectedRun}
              selectedRunEvents={selectedRunEvents}
              mergeBatches={mergeBatches}
              stats={stats}
              titleLookup={titleLookup}
              mode={runsViewMode}
              maxVisibleRuns={runsVisible}
            />
          )
        : (
            <StatsView
              stats={stats}
              autoRefresh={autoRefresh}
              pollIntervalMs={pollIntervalMs}
              lastRefreshAt={lastRefreshAt}
            />
          )}

      <ActionsBar
        activeTab={activeTab}
        busy={actionState.busy}
        runFocused={runsViewMode === 'focus'}
        autoRefresh={autoRefresh}
      />
    </Box>
  )
}

interface HeaderProps {
  activeTab: TabId
  pollIntervalMs: number
  dryRun: boolean
  status: TuiStatsSnapshot
  autoRefresh: boolean
  lastRefreshAt: string
}

function Header({ activeTab, pollIntervalMs, dryRun, status, autoRefresh, lastRefreshAt }: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text bold color="cyan">NIGHT-ORCH CONTROL ROOM</Text>
        <Text color="gray">  refresh {pollIntervalMs / 1000}s</Text>
        {dryRun && <Text color="yellow">  [dry-run]</Text>}
        <Text color={autoRefresh ? 'green' : 'yellow'}>  {autoRefresh ? '● live' : '○ paused'}</Text>
        <Text color="gray">  updated {formatTime(lastRefreshAt)}</Text>
      </Box>
      <Box>
        {TABS.map((tab) => (
          <Box key={tab.id} marginRight={2}>
            <Text color={activeTab === tab.id ? 'cyan' : 'gray'}>
              {activeTab === tab.id ? '▸' : ' '}[{tab.hotkey}] {tab.label}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color="gray">
        runs {status.overview.totalRuns}  active {status.overview.activeRuns}  queued {status.overview.queuedRuns}  running {status.overview.runningRuns}  cost today ${status.cost.todayCostUsd.toFixed(2)}
      </Text>
    </Box>
  )
}

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
}

function RunsView({
  runs,
  selectedIndex,
  selectedRun,
  selectedRunEvents,
  mergeBatches,
  stats,
  titleLookup,
  mode,
  maxVisibleRuns,
}: RunsViewProps): React.ReactElement {
  if (mode === 'focus') {
    return (
      <FocusedRunView
        selectedRun={selectedRun}
        selectedRunEvents={selectedRunEvents}
        titleLookup={titleLookup}
        stats={stats}
        mergeBatches={mergeBatches}
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
}

function FocusedRunView({ selectedRun, selectedRunEvents, titleLookup, stats, mergeBatches }: FocusedRunViewProps): React.ReactElement {
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
              {selectedRunEvents.map((event) => {
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
            </Box>
          </Box>
          <Text color="gray">Press Esc or o to return to list</Text>
        </>
      )}
    </Box>
  )
}

interface StatsViewProps {
  stats: TuiStatsSnapshot
  autoRefresh: boolean
  pollIntervalMs: number
  lastRefreshAt: string
}

function StatsView({ stats, autoRefresh, pollIntervalMs, lastRefreshAt }: StatsViewProps): React.ReactElement {
  const costSeries = stats.cost.dailyHistory.slice().reverse().map((row) => row.totalCostUsd)

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text color={autoRefresh ? 'green' : 'yellow'}>{autoRefresh ? '● stats polling active' : '○ stats polling paused'}</Text>
        <Text color="gray">  interval {pollIntervalMs / 1000}s</Text>
        <Text color="gray">  last refresh {formatTime(lastRefreshAt)}</Text>
      </Box>

      <Box marginBottom={1}>
        <StatCard title="Run Health" width="50%" marginRight={1}>
          <Text>total {stats.overview.totalRuns}  active {stats.overview.activeRuns}</Text>
          <Text color="gray">running {stats.overview.runningRuns}  queued {stats.overview.queuedRuns}</Text>
          <Text color="gray">review_ready {stats.overview.reviewReadyRuns}  completed {stats.overview.completedRuns}</Text>
          <Text color="gray">blocked {stats.overview.blockedRuns}  error {stats.overview.errorRuns}</Text>
          <Text color="gray">mix {formatStatusMix(stats.statusCounts)}</Text>
        </StatCard>

        <StatCard title="Throughput" width="50%">
          <Text>runs 24h {stats.throughput.runs24h}  7d {stats.throughput.runs7d}  30d {stats.throughput.runs30d}</Text>
          <Text color="gray">completed 7d {stats.throughput.completed7d}</Text>
          <Text color="gray">blocked 7d {stats.throughput.blocked7d}  error 7d {stats.throughput.error7d}</Text>
          <Text color="gray">success 7d {stats.throughput.successRate7d.toFixed(1)}%</Text>
          <Text color="gray">avg duration {formatMinutes(stats.throughput.avgDurationMinutes7d)}  avg iter {stats.throughput.avgIterations7d.toFixed(2)}</Text>
        </StatCard>
      </Box>

      <Box marginBottom={1}>
        <StatCard title="Cost" width="50%" marginRight={1}>
          <Text>today ${stats.cost.todayCostUsd.toFixed(2)} ({stats.cost.todayRunCount} runs)</Text>
          <Text color="gray">7d ${stats.cost.cost7d.toFixed(2)}  30d ${stats.cost.cost30d.toFixed(2)}</Text>
          <Text color="gray">avg/day 7d ${stats.cost.avgDailyCost7d.toFixed(2)}</Text>
          <Text color="gray">trend {buildSparkline(costSeries)}</Text>
          {stats.cost.dailyHistory.slice(0, 4).map((row) => (
            <Text key={row.date} color="gray">{row.date}: ${row.totalCostUsd.toFixed(2)} ({row.runCount})</Text>
          ))}
        </StatCard>

        <StatCard title="Agent Activity" width="50%">
          <Text>events total {stats.agents.eventsTotal}</Text>
          <Text color="gray">24h {stats.agents.events24h}  7d {stats.agents.events7d}</Text>
          <Text color="gray">tool calls 24h {stats.agents.toolCalls24h}</Text>
          <Text color="gray">thinking 24h {stats.agents.thinking24h}  runs 7d {stats.agents.uniqueRuns7d}</Text>
          <Text color="gray">
            roles {stats.agents.roleBreakdown7d.length === 0 ? '-' : stats.agents.roleBreakdown7d.map((row) => `${row.role}:${row.events}`).join('  ')}
          </Text>
        </StatCard>
      </Box>

      <Box>
        <StatCard title="Merge Queue" width="35%" marginRight={1}>
          <Text>active batches {stats.queue.activeBatches}</Text>
          <Text color="gray">
            statuses {stats.queue.statuses.length === 0 ? '-' : stats.queue.statuses.map((row) => `${row.status}:${row.count}`).join('  ')}
          </Text>
          <Text color="gray">
            active phases {stats.phaseCounts.length === 0 ? '-' : stats.phaseCounts.map((row) => `${row.phase}:${row.count}`).join('  ')}
          </Text>
        </StatCard>

        <StatCard title="Top Repositories (30d)" width="65%">
          {stats.topRepos30d.length === 0 && <Text color="gray">No run history</Text>}
          {stats.topRepos30d.map((row) => {
            const terminalCount = row.completedRuns + row.blockedRuns + row.errorRuns
            const successPct = terminalCount > 0 ? (row.completedRuns / terminalCount) * 100 : 0
            return (
              <Text key={row.repo}>
                <Text>{truncate(row.repo, 28)}</Text>
                {'  '}
                <Text color="gray">runs {row.totalRuns}</Text>
                {'  '}
                <Text color="green">ok {successPct.toFixed(0)}%</Text>
                {'  '}
                <Text color="gray">cost ${row.totalCostUsd.toFixed(2)}</Text>
                {'  '}
                <Text color="gray">iter {row.avgIterations.toFixed(1)}</Text>
              </Text>
            )
          })}
        </StatCard>
      </Box>
    </Box>
  )
}

interface StatCardProps {
  title: string
  width: string
  marginRight?: number
  children: React.ReactNode
}

function StatCard({ title, width, marginRight = 0, children }: StatCardProps): React.ReactElement {
  return (
    <Box
      width={width}
      marginRight={marginRight}
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold color="cyan">{title}</Text>
      {children}
    </Box>
  )
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
