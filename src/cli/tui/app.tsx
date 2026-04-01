import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import type { Config } from '../../config/schema.js'
import { RetryEngine } from '../../ops/retry.js'
import { SyncEngine } from '../../ops/sync.js'
import { CleanupEngine } from '../../ops/cleanup.js'
import { pollOnce } from '../../runner/poller.js'
import { queueRebase } from '../../ops/rebase-and-check.js'
import { createForgeAdapter } from '../../forge/factory.js'
import type Database from 'better-sqlite3'
import { loadTuiStats } from '../../state/stats.js'
import { ActionsBar } from './actions-bar.js'
import { loadRuns, loadAgentEvents, loadMergeBatches, type RunListRow } from './data.js'
import { Header } from './header.js'
import { LogsView } from './logs-view.js'
import { RunsView } from './runs-view.js'
import { StatsView } from './stats-view.js'
import { collectMissingTitleTargets, hasReadableTitle, type TitleLookup } from './titles.js'
import { TABS } from './constants.js'
import type { RunsViewMode, TabId, TuiLogLine } from './types.js'

interface AppProps {
  db: Database.Database
  config: Config
  pollIntervalMs?: number
  dryRun?: boolean
  enableBackgroundPoller?: boolean
}

interface ActionState {
  busy: boolean
  action: string | null
}

const MAX_LOG_LINES = 500
const FOCUSED_EVENT_WINDOW_SIZE = 18
const LOG_WINDOW_SIZE = 18

export function App({
  db,
  config,
  pollIntervalMs = 2000,
  dryRun = false,
  enableBackgroundPoller = true,
}: AppProps): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const [termRows, setTermRows] = useState(stdout.rows ?? 24)
  const [tick, setTick] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState('Ready')
  const [actionState, setActionState] = useState<ActionState>({ busy: false, action: null })
  const [activeTab, setActiveTab] = useState<TabId>('runs')
  const [runsViewMode, setRunsViewMode] = useState<RunsViewMode>('list')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastRefreshAt, setLastRefreshAt] = useState(new Date().toISOString())
  const [titleLookup, setTitleLookup] = useState<TitleLookup>({ issues: {}, prs: {} })
  const [runEventScrollOffset, setRunEventScrollOffset] = useState(0)
  const [logScrollOffset, setLogScrollOffset] = useState(0)
  const [logLines, setLogLines] = useState<TuiLogLine[]>([])
  const [startupReady, setStartupReady] = useState(!enableBackgroundPoller)

  const attemptedIssueKeys = useRef<Set<string>>(new Set())
  const attemptedPrKeys = useRef<Set<string>>(new Set())
  const lastHydrationAt = useRef(0)
  const logSequence = useRef(1)
  const pollInFlight = useRef(false)
  const pollPromise = useRef<Promise<unknown> | null>(null)
  const shuttingDown = useRef(false)

  useEffect(() => {
    const onResize = () => setTermRows(stdout.rows ?? 24)
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  const appendLog = useCallback((level: TuiLogLine['level'], message: string) => {
    setLogLines((current) => {
      const next = [
        ...current,
        {
          id: logSequence.current++,
          createdAt: new Date().toISOString(),
          level,
          message,
        },
      ]
      if (next.length <= MAX_LOG_LINES) return next
      return next.slice(next.length - MAX_LOG_LINES)
    })
  }, [])

  useEffect(() => {
    const maxOffset = Math.max(0, logLines.length - LOG_WINDOW_SIZE)
    setLogScrollOffset((current) => Math.min(current, maxOffset))
  }, [logLines.length])

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

  useEffect(() => {
    if (!enableBackgroundPoller) return
    let alive = true

    void (async () => {
      appendLog('info', 'startup recovery: begin')
      try {
        const { LeaseManager } = await import('../../state/leases.js')
        const leaseManager = new LeaseManager(db)
        const releasedLeases = leaseManager.releaseAll()
        if (releasedLeases > 0) {
          appendLog('info', `startup recovery: released ${releasedLeases} orphaned lease(s)`)
        }
      } catch (err) {
        appendLog('warn', `startup recovery: lease cleanup failed: ${(err as Error).message}`)
      }

      try {
        const syncEngine = new SyncEngine(db, config)
        const syncResult = await syncEngine.reconcile(dryRun)
        appendLog(
          'info',
          `startup recovery: ${syncResult.reconciledRuns.length} reconciled, ${syncResult.expiredLeases} expired lease(s)`,
        )
      } catch (err) {
        appendLog('warn', `startup recovery: sync failed: ${(err as Error).message}`)
      }

      if (!alive) return
      setStartupReady(true)
      setTick((t) => t + 1)
    })()

    return () => {
      alive = false
    }
  }, [appendLog, config, db, dryRun, enableBackgroundPoller])

  const runs = useMemo(() => loadRuns(db), [db, tick])
  const selectedIndex = runs.findIndex((run) => run.id === selectedRunId)
  const selectedRun = selectedIndex >= 0 ? (runs[selectedIndex] ?? null) : (runs[0] ?? null)
  const selectedRunEvents = useMemo(
    () => (selectedRun ? loadAgentEvents(db, selectedRun.id, runsViewMode === 'focus' ? 240 : 12) : []),
    [db, tick, selectedRun?.id, runsViewMode],
  )
  const mergeBatches = useMemo(() => loadMergeBatches(db), [db, tick])
  const stats = useMemo(() => loadTuiStats(db), [db, tick])

  useEffect(() => {
    const maxOffset = Math.max(0, selectedRunEvents.length - FOCUSED_EVENT_WINDOW_SIZE)
    setRunEventScrollOffset((current) => Math.min(current, maxOffset))
  }, [selectedRunEvents.length])

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

  const runPollCycle = useCallback(async (
    trigger: 'auto' | 'manual',
    targetRun?: RunListRow | null,
  ): Promise<string> => {
    if (pollInFlight.current) {
      return 'poll already in progress'
    }
    pollInFlight.current = true
    const p = (async () => {
      const targetIssue = trigger === 'manual' && targetRun
        ? { repo: targetRun.repo, issueNumber: targetRun.issue_number }
        : undefined
      const result = await pollOnce(config, db, dryRun, undefined, targetIssue)
      const targetSuffix = targetIssue ? ` for ${targetIssue.repo}#${targetIssue.issueNumber}` : ''
      const summary = `${result.processed} processed, ${result.errors} error(s)${targetSuffix}${dryRun ? ' (dry-run)' : ''}`
      appendLog('info', `${trigger} poll: ${summary}`)
      return summary
    })()
    pollPromise.current = p
    try {
      return await p
    } catch (err) {
      appendLog('error', `${trigger} poll failed: ${(err as Error).message}`)
      throw err
    } finally {
      pollInFlight.current = false
      pollPromise.current = null
      setTick((t) => t + 1)
    }
  }, [appendLog, config, db, dryRun])

  useEffect(() => {
    if (!enableBackgroundPoller || !startupReady || !autoRefresh) return
    let stopped = false

    const cycle = async () => {
      if (stopped || shuttingDown.current) return
      try {
        const summary = await runPollCycle('auto')
        setStatusLine(`poll: ${summary}`)
      } catch (err) {
        setStatusLine(`poll failed: ${(err as Error).message}`)
      }
    }

    void cycle()
    const timer = setInterval(() => {
      void cycle()
    }, pollIntervalMs)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [autoRefresh, enableBackgroundPoller, pollIntervalMs, runPollCycle, startupReady])

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
    appendLog('info', `action ${actionName}: start`)
    try {
      const result = await actionFn()
      setStatusLine(`${actionName}: ${result}`)
      appendLog('info', `action ${actionName}: ${result}`)
    } catch (err) {
      const message = (err as Error).message
      setStatusLine(`${actionName} failed: ${message}`)
      appendLog('error', `action ${actionName} failed: ${message}`)
    } finally {
      setActionState({ busy: false, action: null })
      setTick((t) => t + 1)
    }
  }, [actionState.busy, appendLog])

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
    await runAction('poll', async () => runPollCycle('manual', selectedRun))
  }, [runAction, runPollCycle, selectedRun])

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
      } catch {
        // Best effort only.
      }
      const result = await queueRebase(db, forge, repoConfig, target.issue_number, botUser)
      return `${target.repo}#${target.issue_number}: ${result.reason}`
    })
  }, [config, db, runAction, runs, selectedRun])

  const gracefulExit = useCallback(() => {
    if (shuttingDown.current) return
    shuttingDown.current = true

    if (!pollInFlight.current) {
      exit()
      return
    }

    setStatusLine('Shutting down — waiting for current operation to finish...')
    const pending = pollPromise.current
    if (pending) {
      void pending.finally(() => exit())
    } else {
      exit()
    }
  }, [exit])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      gracefulExit()
      return
    }

    if (activeTab === 'runs' && runsViewMode === 'focus') {
      if (key.escape || input === 'q') {
        setRunsViewMode('list')
        setStatusLine('Closed run detail')
        return
      }
      if (key.downArrow || input === 'j') {
        setRunEventScrollOffset((current) => current + 1)
        return
      }
      if (key.upArrow || input === 'k') {
        setRunEventScrollOffset((current) => Math.max(0, current - 1))
        return
      }
    }

    if (input === 'q') {
      gracefulExit()
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
    if (input === '3') {
      setActiveTab('logs')
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

    if (activeTab === 'runs' && runsViewMode === 'list') {
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
          setRunsViewMode('focus')
          setRunEventScrollOffset(0)
        }
        return
      }
    }

    if (activeTab === 'logs') {
      if (key.downArrow || input === 'j') {
        setLogScrollOffset((current) => current + 1)
        return
      }
      if (key.upArrow || input === 'k') {
        setLogScrollOffset((current) => Math.max(0, current - 1))
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
        appendLog('info', next ? 'auto-refresh enabled' : 'auto-refresh paused')
        return next
      })
      return
    }

    if (actionState.busy) {
      return
    }

    if (activeTab !== 'runs' || runsViewMode === 'focus') {
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
    <Box flexDirection="column" height={termRows}>
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

      {activeTab === 'runs' && (
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
          eventScrollOffset={runEventScrollOffset}
          eventWindowSize={FOCUSED_EVENT_WINDOW_SIZE}
        />
      )}
      {activeTab === 'stats' && (
        <StatsView
          stats={stats}
          autoRefresh={autoRefresh}
          pollIntervalMs={pollIntervalMs}
          lastRefreshAt={lastRefreshAt}
        />
      )}
      {activeTab === 'logs' && (
        <LogsView
          logs={logLines}
          scrollOffset={logScrollOffset}
          windowSize={LOG_WINDOW_SIZE}
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
