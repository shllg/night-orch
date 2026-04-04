import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import type { Config } from '../../config/schema.js'
import { RetryEngine } from '../../ops/retry.js'
import { SyncEngine } from '../../ops/sync.js'
import { CleanupEngine } from '../../ops/cleanup.js'
import { LabelsInitEngine, formatLabelsInitSummary } from '../../ops/labels-init.js'
import { DeleteIssueEntryEngine } from '../../ops/delete-entry.js'
import { pollOnce } from '../../runner/poller.js'
import { queueRebase } from '../../ops/rebase-and-check.js'
import { queueContinue } from '../../ops/continue.js'
import { createForgeAdapter } from '../../forge/factory.js'
import type Database from 'better-sqlite3'
import { loadTuiStats } from '../../state/stats.js'
import { ActionsBar } from './actions-bar.js'
import { buildIssueList, loadRuns, loadAgentEvents, loadMergeBatches, type IssueListRow } from './data.js'
import { Header } from './header.js'
import { LogsView } from './logs-view.js'
import { ProjectsView } from './projects-view.js'
import { RunsView } from './runs-view.js'
import { StatsView } from './stats-view.js'
import { collectMissingTitleTargets, hasReadableTitle, type TitleLookup } from './titles.js'
import { TABS } from './constants.js'
import type { RunsViewMode, TabId, TuiLogLine } from './types.js'
import { formatUtcClock, nowUtcIso } from '../../utils/time.js'
import { getBuildInfo } from '../../utils/build-info.js'

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
const MIN_LOG_WINDOW_SIZE = 4
const LOG_WINDOW_RESERVED_ROWS = 17
const EXIT_GRACE_TIMEOUT_MS = 15_000
const CLEANUP_CONFIRM_TIMEOUT_MS = 5_000
const BUILD_INFO = getBuildInfo()

export function resolveTabHotkey(input: string): TabId | null {
  if (input === '1') return 'runs'
  if (input === '2') return 'projects'
  if (input === '3') return 'stats'
  if (input === '4') return 'logs'
  return null
}

export function moveProjectSelection(current: number, direction: -1 | 1, projectCount: number): number {
  const maxProjectIndex = Math.max(0, projectCount - 1)
  return Math.max(0, Math.min(maxProjectIndex, current + direction))
}

export function resolveSelectedLogIndex(logs: TuiLogLine[], selectedLogId: number | null): number {
  if (logs.length === 0) return -1
  if (selectedLogId === null) return -1
  return logs.findIndex((line) => line.id === selectedLogId)
}

interface LogSelectionSnapshot {
  selectedLogId: number | null
  selectedLogIndex: number
  logCount: number
}

export function reconcileSelectedLogId(
  logs: TuiLogLine[],
  selectedLogId: number | null,
  previousSelectedIndex: number,
  previousLogCount: number,
): number | null {
  if (logs.length === 0) return null

  const previousTailIndex = previousLogCount > 0 ? previousLogCount - 1 : -1
  const wasAtTail = previousSelectedIndex >= 0 && previousSelectedIndex >= previousTailIndex
  const selectedIndex = resolveSelectedLogIndex(logs, selectedLogId)

  if (selectedIndex >= 0) {
    if (wasAtTail && selectedIndex !== logs.length - 1) {
      return logs[logs.length - 1]!.id
    }
    return selectedLogId
  }

  if (wasAtTail || selectedLogId === null) {
    return logs[logs.length - 1]!.id
  }

  const fallbackIndex = Math.max(0, Math.min(logs.length - 1, previousSelectedIndex))
  return logs[fallbackIndex]!.id
}

export function moveLogSelection(logs: TuiLogLine[], selectedLogId: number | null, direction: -1 | 1): number | null {
  if (logs.length === 0) return null
  const currentIndex = resolveSelectedLogIndex(logs, selectedLogId)
  const safeIndex = currentIndex >= 0 ? currentIndex : logs.length - 1
  const nextIndex = Math.max(0, Math.min(logs.length - 1, safeIndex + direction))
  return logs[nextIndex]!.id
}

export function reconcileLogSelectionSnapshot(
  logs: TuiLogLine[],
  selectedLogId: number | null,
  previousSelectedIndex: number,
  previousLogCount: number,
): LogSelectionSnapshot {
  const nextSelectedLogId = reconcileSelectedLogId(logs, selectedLogId, previousSelectedIndex, previousLogCount)
  return {
    selectedLogId: nextSelectedLogId,
    selectedLogIndex: resolveSelectedLogIndex(logs, nextSelectedLogId),
    logCount: logs.length,
  }
}

export function resolveLogWindowSize(termRows: number): number {
  return Math.max(MIN_LOG_WINDOW_SIZE, termRows - LOG_WINDOW_RESERVED_ROWS)
}

export type CleanupConfirmationEvent = 'pressD' | 'pressOther' | 'timeout'
export type CleanupConfirmationTransition = 'none' | 'arm' | 'confirm' | 'cancel' | 'expire'

export function resolveCleanupConfirmationTransition(
  pending: boolean,
  event: CleanupConfirmationEvent,
): CleanupConfirmationTransition {
  if (!pending) {
    return event === 'pressD' ? 'arm' : 'none'
  }

  if (event === 'pressD') return 'confirm'
  if (event === 'pressOther') return 'cancel'
  if (event === 'timeout') return 'expire'
  return 'none'
}

export type TuiActionCommand =
  | 'none'
  | 'refresh'
  | 'poll'
  | 'sync'
  | 'labelsInit'
  | 'retry'
  | 'retryFresh'
  | 'continue'
  | 'rebase'
  | 'deleteEntry'
  | 'cleanupArm'
  | 'cleanupConfirm'
  | 'standaloneMessage'

interface ResolveActionCommandInput {
  input: string
  activeTab: TabId
  runsViewMode: RunsViewMode
  controlsEnabled: boolean
  actionBusy: boolean
  cleanupConfirmPending: boolean
}

export function resolveActionCommand(args: ResolveActionCommandInput): TuiActionCommand {
  if (args.input === 'r') return 'refresh'

  const isFocusedRun = args.activeTab === 'runs' && args.runsViewMode === 'focus'
  const monitorOnlyActionKey = args.input === 'p'
    || args.input === 's'
    || args.input === 'D'
    || args.input === 'L'

  if (args.actionBusy) return 'none'

  if (!args.controlsEnabled && monitorOnlyActionKey) {
    return 'standaloneMessage'
  }

  // Keep focused run detail isolated to match its legend.
  if (isFocusedRun && (args.input === 'p' || args.input === 's' || args.input === 'D' || args.input === 'L')) {
    return 'none'
  }

  if (args.input === 'p') return 'poll'
  if (args.input === 's') return 'sync'
  if (args.input === 'L') return 'labelsInit'

  if (args.input === 'D') {
    return args.cleanupConfirmPending ? 'cleanupConfirm' : 'cleanupArm'
  }

  if (args.activeTab !== 'runs' || args.runsViewMode !== 'list') {
    return 'none'
  }

  if (args.input === 't') return 'retry'
  if (args.input === 'T') return 'retryFresh'
  if (args.input === 'c') return 'continue'
  if (args.input === '_') return 'rebase'
  if (args.input === 'X') return 'deleteEntry'
  return 'none'
}

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
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState('Ready')
  const [actionState, setActionState] = useState<ActionState>({ busy: false, action: null })
  const [activeTab, setActiveTab] = useState<TabId>('runs')
  const [runsViewMode, setRunsViewMode] = useState<RunsViewMode>('list')
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [cleanupConfirmPending, setCleanupConfirmPending] = useState(false)
  const [lastRefreshAt, setLastRefreshAt] = useState(nowUtcIso())
  const [titleLookup, setTitleLookup] = useState<TitleLookup>({ issues: {}, prs: {} })
  const [runEventScrollOffset, setRunEventScrollOffset] = useState(0)
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null)
  const [logDetailScrollOffset, setLogDetailScrollOffset] = useState(0)
  const [logLines, setLogLines] = useState<TuiLogLine[]>([])
  const [startupReady, setStartupReady] = useState(!enableBackgroundPoller)

  const attemptedIssueKeys = useRef<Set<string>>(new Set())
  const attemptedPrKeys = useRef<Set<string>>(new Set())
  const lastHydrationAt = useRef(0)
  const lastLogCount = useRef(0)
  const selectedLogIndexRef = useRef(-1)
  const logSequence = useRef(1)
  const pollInFlight = useRef(false)
  const pollPromise = useRef<Promise<unknown> | null>(null)
  const actionPromise = useRef<Promise<unknown> | null>(null)
  const shuttingDown = useRef(false)
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cleanupConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
          createdAt: nowUtcIso(),
          level,
          message,
        },
      ]
      if (next.length <= MAX_LOG_LINES) return next
      return next.slice(next.length - MAX_LOG_LINES)
    })
  }, [])

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
    setLastRefreshAt(nowUtcIso())
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
  const issues = useMemo(() => buildIssueList(runs), [runs])
  const selectedIndex = issues.findIndex((issue) => issue.key === selectedIssueKey)
  const selectedIssue = selectedIndex >= 0 ? (issues[selectedIndex] ?? null) : (issues[0] ?? null)
  const selectedRun = selectedIssue?.runs[0] ?? null
  const selectedRunEvents = useMemo(
    () => (selectedRun ? loadAgentEvents(db, selectedRun.id, runsViewMode === 'focus' ? 240 : 12) : []),
    [db, tick, selectedRun?.id, runsViewMode],
  )
  const mergeBatches = useMemo(() => loadMergeBatches(db), [db, tick])
  const stats = useMemo(() => loadTuiStats(db), [db, tick])
  const logWindowSize = useMemo(() => resolveLogWindowSize(termRows), [termRows])
  const selectedLogIndex = useMemo(() => resolveSelectedLogIndex(logLines, selectedLogId), [logLines, selectedLogId])

  useEffect(() => {
    const snapshot = reconcileLogSelectionSnapshot(
      logLines,
      selectedLogId,
      selectedLogIndexRef.current,
      lastLogCount.current,
    )
    setSelectedLogId(snapshot.selectedLogId)
    selectedLogIndexRef.current = snapshot.selectedLogIndex
    lastLogCount.current = snapshot.logCount
  }, [logLines, selectedLogId])

  useEffect(() => {
    setLogDetailScrollOffset(0)
  }, [selectedLogId])

  useEffect(() => {
    const maxOffset = Math.max(0, selectedRunEvents.length - FOCUSED_EVENT_WINDOW_SIZE)
    setRunEventScrollOffset((current) => Math.min(current, maxOffset))
  }, [selectedRunEvents.length])

  useEffect(() => {
    if (issues.length === 0) {
      if (selectedIssueKey !== null) setSelectedIssueKey(null)
      return
    }
    if (!selectedIssueKey || !issues.some((issue) => issue.key === selectedIssueKey)) {
      setSelectedIssueKey(issues[0]!.key)
    }
  }, [issues, selectedIssueKey])

  useEffect(() => {
    const maxIndex = Math.max(0, config.repos.length - 1)
    setSelectedProjectIndex((current) => Math.max(0, Math.min(current, maxIndex)))
  }, [config.repos])

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
      const updateIssueAggregateStmt = db.prepare(
        `UPDATE issues
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
      const updatePrAggregateStmt = db.prepare(
        `UPDATE issues
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
            updateIssueAggregateStmt.run(title, target.repo, target.issueNumber)
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
            updatePrAggregateStmt.run(title, target.repo, target.prNumber)
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
    targetIssue?: IssueListRow | null,
  ): Promise<string> => {
    if (pollInFlight.current) {
      return 'poll already in progress'
    }
    pollInFlight.current = true
    const p = (async () => {
      const target = trigger === 'manual' && targetIssue
        ? { repo: targetIssue.repo, issueNumber: targetIssue.issue_number }
        : undefined
      const result = await pollOnce(config, db, dryRun, undefined, target)
      const targetSuffix = target ? ` for ${target.repo}#${target.issueNumber}` : ''
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
    if (issues.length === 0) return

    const currentIndex = selectedIssue
      ? issues.findIndex((issue) => issue.key === selectedIssue.key)
      : 0
    const safeIndex = currentIndex >= 0 ? currentIndex : 0
    const nextIndex = Math.max(0, Math.min(issues.length - 1, safeIndex + direction))
    const nextIssue = issues[nextIndex]
    if (nextIssue) {
      setSelectedIssueKey(nextIssue.key)
    }
  }, [issues, selectedIssue])

  const switchTab = useCallback((direction: -1 | 1) => {
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab)
    const nextIndex = Math.max(0, Math.min(TABS.length - 1, currentIndex + direction))
    const next = TABS[nextIndex]
    if (next) setActiveTab(next.id)
  }, [activeTab])

  const forceRefresh = useCallback(() => {
    setTick((t) => t + 1)
    setStatusLine(`Refreshed at ${formatUtcClock(nowUtcIso())}`)
  }, [])

  const runAction = useCallback(async (
    actionName: string,
    actionFn: () => Promise<string>,
  ) => {
    if (actionState.busy) return
    setActionState({ busy: true, action: actionName })
    setStatusLine(`Running ${actionName}...`)
    appendLog('info', `action ${actionName}: start`)
    const actionTask = actionFn()
    actionPromise.current = actionTask
    try {
      const result = await actionTask
      setStatusLine(`${actionName}: ${result}`)
      appendLog('info', `action ${actionName}: ${result}`)
    } catch (err) {
      const message = (err as Error).message
      setStatusLine(`${actionName} failed: ${message}`)
      appendLog('error', `action ${actionName} failed: ${message}`)
    } finally {
      if (actionPromise.current === actionTask) {
        actionPromise.current = null
      }
      setActionState({ busy: false, action: null })
      setTick((t) => t + 1)
    }
  }, [actionState.busy, appendLog])

  const runRetry = useCallback(async (fresh = false) => {
    const label = fresh ? 'retry-fresh' : 'retry'
    await runAction(label, async () => {
      if (!selectedIssue) throw new Error('No issue selected')
      const engine = new RetryEngine(db, config)
      await engine.retry(selectedIssue.repo, selectedIssue.issue_number, {
        immediate: false,
        resetPlan: fresh,
        resetBranch: fresh,
        dryRun,
      })
      const suffix = fresh ? ' (fresh start)' : ''
      return `queued ${selectedIssue.repo}#${selectedIssue.issue_number}${suffix}${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, runAction, selectedIssue])

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

  const runLabelsInit = useCallback(async () => {
    await runAction('labels-init', async () => {
      const targetRepo = activeTab === 'projects'
        ? config.repos[selectedProjectIndex]?.repo
        : selectedIssue?.repo ?? config.repos[0]?.repo

      if (!targetRepo) {
        throw new Error('No repositories configured')
      }

      const engine = new LabelsInitEngine(config)
      const result = await engine.run({
        targetRepo,
        dryRun,
      })
      return `${targetRepo}: ${formatLabelsInitSummary(result)}`
    })
  }, [activeTab, config, dryRun, runAction, selectedIssue, selectedProjectIndex])

  const clearCleanupConfirmation = useCallback(() => {
    if (cleanupConfirmTimer.current) {
      clearTimeout(cleanupConfirmTimer.current)
      cleanupConfirmTimer.current = null
    }
    setCleanupConfirmPending(false)
  }, [])

  const runPoll = useCallback(async () => {
    await runAction('poll', async () => runPollCycle('manual', selectedIssue))
  }, [runAction, runPollCycle, selectedIssue])

  const runRebase = useCallback(async () => {
    await runAction('rebase', async () => {
      const target = selectedIssue ?? issues.find((issue) => issue.status === 'review_ready')
      if (!target) throw new Error('No issue selected')
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
  }, [config, db, issues, runAction, selectedIssue])

  const runContinue = useCallback(async () => {
    await runAction('continue', async () => {
      const target = selectedIssue ?? issues.find((issue) => issue.status === 'blocked' || issue.status === 'review_ready' || issue.status === 'error')
      if (!target) throw new Error('No issue selected')
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
      const result = await queueContinue(db, forge, repoConfig, target.issue_number, botUser, { dryRun })
      return `${target.repo}#${target.issue_number}: ${result.reason}${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, issues, runAction, selectedIssue])

  const runDeleteEntry = useCallback(async () => {
    await runAction('delete-entry', async () => {
      if (!selectedIssue) throw new Error('No issue selected')
      const engine = new DeleteIssueEntryEngine(db, config)
      const result = await engine.deleteEntry(selectedIssue.repo, selectedIssue.issue_number, {
        dryRun,
        force: false,
      })
      if (!result.found) {
        return `no local entry for ${selectedIssue.repo}#${selectedIssue.issue_number}${dryRun ? ' (dry-run)' : ''}`
      }
      const warningSuffix = result.worktreesFailed.length > 0
        ? `, ${result.worktreesFailed.length} worktree warning(s)`
        : ''
      return `${selectedIssue.repo}#${selectedIssue.issue_number}: ${result.runsDeleted} run(s), ${result.issuesDeleted} issue row(s), ${result.worktreesRemoved.length} worktree(s)${warningSuffix}${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, runAction, selectedIssue])

  const gracefulExit = useCallback(() => {
    if (shuttingDown.current) {
      if (exitTimer.current) {
        clearTimeout(exitTimer.current)
        exitTimer.current = null
      }
      setStatusLine('Forced shutdown')
      exit()
      return
    }
    shuttingDown.current = true

    const pendingTasks = [pollPromise.current, actionPromise.current].filter(
      (task): task is Promise<unknown> => task !== null,
    )

    if (pendingTasks.length === 0) {
      exit()
      return
    }

    setStatusLine('Shutting down — waiting for current operation to finish (press q/Ctrl+C again to force)...')
    exitTimer.current = setTimeout(() => {
      setStatusLine('Shutdown timeout reached — forcing exit')
      exit()
    }, EXIT_GRACE_TIMEOUT_MS)

    void Promise.allSettled(pendingTasks).finally(() => {
      if (exitTimer.current) {
        clearTimeout(exitTimer.current)
        exitTimer.current = null
      }
      exit()
    })
  }, [exit])

  useEffect(() => {
    return () => {
      if (exitTimer.current) {
        clearTimeout(exitTimer.current)
        exitTimer.current = null
      }
      if (cleanupConfirmTimer.current) {
        clearTimeout(cleanupConfirmTimer.current)
        cleanupConfirmTimer.current = null
      }
    }
  }, [])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      gracefulExit()
      return
    }

    const focusedRunDetail = activeTab === 'runs' && runsViewMode === 'focus'
    if (cleanupConfirmPending && (input !== 'D' || focusedRunDetail)) {
      const transition = resolveCleanupConfirmationTransition(true, 'pressOther')
      if (transition === 'cancel') {
        clearCleanupConfirmation()
      }
    }

    if (focusedRunDetail) {
      if (key.escape || input === 'q') {
        setRunsViewMode('list')
        setStatusLine('Closed issue detail')
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

    const tabFromHotkey = resolveTabHotkey(input)
    if (tabFromHotkey) {
      setActiveTab(tabFromHotkey)
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
        if (selectedIssue) {
          setRunsViewMode('focus')
          setRunEventScrollOffset(0)
        }
        return
      }
    }

    if (activeTab === 'projects') {
      if (key.downArrow || input === 'j') {
        setSelectedProjectIndex((current) => moveProjectSelection(current, 1, config.repos.length))
        return
      }
      if (key.upArrow || input === 'k') {
        setSelectedProjectIndex((current) => moveProjectSelection(current, -1, config.repos.length))
        return
      }
    }

    if (activeTab === 'logs') {
      if (key.downArrow || input === 'j') {
        const nextId = moveLogSelection(logLines, selectedLogId, 1)
        setSelectedLogId(nextId)
        selectedLogIndexRef.current = resolveSelectedLogIndex(logLines, nextId)
        return
      }
      if (key.upArrow || input === 'k') {
        const nextId = moveLogSelection(logLines, selectedLogId, -1)
        setSelectedLogId(nextId)
        selectedLogIndexRef.current = resolveSelectedLogIndex(logLines, nextId)
        return
      }
      if (input === 'J') {
        setLogDetailScrollOffset((current) => current + 1)
        return
      }
      if (input === 'K') {
        setLogDetailScrollOffset((current) => Math.max(0, current - 1))
        return
      }
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

    const actionCommand = resolveActionCommand({
      input,
      activeTab,
      runsViewMode,
      controlsEnabled: enableBackgroundPoller,
      actionBusy: actionState.busy,
      cleanupConfirmPending,
    })

    if (actionCommand === 'refresh') {
      forceRefresh()
      return
    }

    if (actionCommand === 'standaloneMessage') {
      setStatusLine('Monitor mode: poll/sync/cleanup/labels-init available via `night-orch` CLI')
      return
    }

    if (actionCommand === 'poll') {
      void runPoll()
      return
    }
    if (actionCommand === 'sync') {
      void runSync()
      return
    }
    if (actionCommand === 'labelsInit') {
      void runLabelsInit()
      return
    }
    if (actionCommand === 'cleanupArm') {
      const transition = resolveCleanupConfirmationTransition(cleanupConfirmPending, 'pressD')
      if (transition !== 'arm') return
      setCleanupConfirmPending(true)
      setStatusLine('Press D again within 5s to confirm cleanup')
      appendLog('warn', 'cleanup requested: awaiting confirmation')
      if (cleanupConfirmTimer.current) {
        clearTimeout(cleanupConfirmTimer.current)
      }
      cleanupConfirmTimer.current = setTimeout(() => {
        cleanupConfirmTimer.current = null
        const timeoutTransition = resolveCleanupConfirmationTransition(true, 'timeout')
        if (timeoutTransition === 'expire') {
          setCleanupConfirmPending(false)
          setStatusLine('Cleanup confirmation expired')
        }
      }, CLEANUP_CONFIRM_TIMEOUT_MS)
      return
    }
    if (actionCommand === 'cleanupConfirm') {
      const transition = resolveCleanupConfirmationTransition(cleanupConfirmPending, 'pressD')
      if (transition !== 'confirm') return
      clearCleanupConfirmation()
      void runCleanup()
      return
    }
    if (actionCommand === 'retry') {
      void runRetry()
      return
    }
    if (actionCommand === 'retryFresh') {
      void runRetry(true)
      return
    }
    if (actionCommand === 'continue') {
      void runContinue()
      return
    }
    if (actionCommand === 'rebase') {
      void runRebase()
      return
    }
    if (actionCommand === 'deleteEntry') {
      void runDeleteEntry()
      return
    }
    if (actionCommand === 'none') {
      return
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
        buildInfo={BUILD_INFO}
      />

      <Box marginBottom={1}>
        <Text color={actionState.busy ? 'yellow' : 'gray'}>
          {actionState.busy ? `busy: ${actionState.action ?? 'action'}` : statusLine}
        </Text>
      </Box>

      {activeTab === 'runs' && (
        <RunsView
          issues={issues}
          selectedIndex={selectedIndex < 0 ? 0 : selectedIndex}
          selectedIssue={selectedIssue}
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
      {activeTab === 'projects' && (
        <ProjectsView
          repos={config.repos}
          selectedIndex={selectedProjectIndex}
          workerProfiles={config.workerProfiles}
          globalGithubTokenEnv={config.github.tokenEnv}
          globalGithubApiBaseUrl={config.github.apiBaseUrl}
        />
      )}
      {activeTab === 'logs' && (
        <Box flexGrow={1} minHeight={0}>
          <LogsView
            logs={logLines}
            selectedIndex={selectedLogIndex}
            windowSize={logWindowSize}
            detailScrollOffset={logDetailScrollOffset}
          />
        </Box>
      )}

      <ActionsBar
        activeTab={activeTab}
        busy={actionState.busy}
        runFocused={activeTab === 'runs' && runsViewMode === 'focus'}
        autoRefresh={autoRefresh}
        controlsEnabled={enableBackgroundPoller}
      />
    </Box>
  )
}
