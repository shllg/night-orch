import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import type { Config } from '../../config/schema.js'
import { RetryEngine } from '../../ops/retry.js'
import { setIssueCostOverride } from '../../ops/cost-override.js'
import { setDailyCostCapOverride } from '../../ops/daily-cost-override.js'
import { SyncEngine } from '../../ops/sync.js'
import { CleanupEngine } from '../../ops/cleanup.js'
import { LabelsInitEngine, formatLabelsInitSummary } from '../../ops/labels-init.js'
import { DeleteIssueEntryEngine } from '../../ops/delete-entry.js'
import { pollOnce } from '../../runner/poller.js'
import { queueRebase } from '../../ops/rebase-and-check.js'
import { queueContinue } from '../../ops/continue.js'
import { createForgeAdapter } from '../../forge/factory.js'
import type { UpdateStrategy } from '../../git/worktree.js'
import type Database from 'better-sqlite3'
import { loadTuiStats } from '../../state/stats.js'
import { ActionsBar } from './actions-bar.js'
import { buildIssueList, loadRuns, loadAgentEvents, loadMergeBatches, type IssueListRow } from './data.js'
import { Header } from './header.js'
import { LogsView } from './logs-view.js'
import { ProjectsView } from './projects-view.js'
import { RunsView } from './runs-view.js'
import { SettingsView } from './settings-view.js'
import { StatsView } from './stats-view.js'
import { collectMissingTitleTargets, hasReadableTitle, type TitleLookup } from './titles.js'
import { TABS } from './constants.js'
import type { ProjectsViewMode, RunsViewMode, TabId, TuiLogLine } from './types.js'
import { formatUtcClock, nowUtcIso } from '../../utils/time.js'
import { getBuildInfo } from '../../utils/build-info.js'
import { FileLoopEngine } from '../../fileloop/engine.js'
import {
  clearRuntimeSettingOverride,
  listRuntimeSettings,
  resolveConfigWithRuntimeSettings,
  setRuntimeSettingOverride,
} from '../../settings/runtime.js'
import { FileLoopView } from './views/file-loop.js'

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

function formatSettingValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return '[function]'
  return JSON.stringify(value)
}

export function resolveTabHotkey(input: string): TabId | null {
  if (input === '1') return 'runs'
  if (input === '2') return 'projects'
  if (input === '3') return 'stats'
  if (input === '4') return 'logs'
  if (input === '5') return 'settings'
  if (input === '6') return 'fileloop'
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
  | 'fileLoopStart'
  | 'fileLoopStop'
  | 'labelsInit'
  | 'retry'
  | 'continue'
  | 'rebase'
  | 'deleteEntry'
  | 'costOverride'
  | 'dailyCostOverride'
  | 'toggleStrategy'
  | 'cleanupArm'
  | 'cleanupConfirm'
  | 'standaloneMessage'

interface ResolveActionCommandInput {
  input: string
  activeTab: TabId
  runsViewMode: RunsViewMode
  projectsViewMode: ProjectsViewMode
  controlsEnabled: boolean
  actionBusy: boolean
  cleanupConfirmPending: boolean
}

export function resolveActionCommand(args: ResolveActionCommandInput): TuiActionCommand {
  if (args.input === 'r') return 'refresh'

  const isFocusedRun = args.activeTab === 'runs' && args.runsViewMode === 'focus'
  const isFocusedProject = args.activeTab === 'projects' && args.projectsViewMode === 'focus'
  const isFocusedDetail = isFocusedRun || isFocusedProject
  const monitorOnlyActionKey = args.input === 'p'
    || args.input === 's'
    || args.input === 'D'
    || args.input === 'L'

  if (args.actionBusy) return 'none'

  if (!args.controlsEnabled && monitorOnlyActionKey) {
    return 'standaloneMessage'
  }

  // Keep focused detail screens isolated to match their legend.
  if (isFocusedDetail && (args.input === 'p' || args.input === 's' || args.input === 'D' || args.input === 'L')) {
    return 'none'
  }

  if (args.input === 'p') return 'poll'
  if (args.input === 's') return 'sync'
  if (args.input === 'L') return 'labelsInit'
  if (args.input === '%') return 'dailyCostOverride'
  if (args.activeTab === 'fileloop' && args.input === 'f') return 'fileLoopStart'
  if (args.activeTab === 'fileloop' && args.input === 'x') return 'fileLoopStop'

  if (args.input === 'D') {
    return args.cleanupConfirmPending ? 'cleanupConfirm' : 'cleanupArm'
  }

  if (args.activeTab !== 'runs' || args.runsViewMode !== 'list') {
    return 'none'
  }

  if (args.input === 't' || args.input === 'T') return 'retry'
  if (args.input === 'c') return 'continue'
  if (args.input === '_') return 'rebase'
  if (args.input === 'm') return 'toggleStrategy'
  if (args.input === 'X') return 'deleteEntry'
  if (args.input === '$') return 'costOverride'
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
  const [projectsViewMode, setProjectsViewMode] = useState<ProjectsViewMode>('list')
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0)
  const [selectedSettingIndex, setSelectedSettingIndex] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [cleanupConfirmPending, setCleanupConfirmPending] = useState(false)
  const [lastRefreshAt, setLastRefreshAt] = useState(nowUtcIso())
  const [manualStrategy, setManualStrategy] = useState<UpdateStrategy | null>(null)
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

  const runtimeConfig = useMemo(
    () => resolveConfigWithRuntimeSettings(config, db),
    [config, db, tick],
  )
  const effectivePollIntervalMs = runtimeConfig.github.pollIntervalSeconds > 0
    ? runtimeConfig.github.pollIntervalSeconds * 1000
    : pollIntervalMs
  const runtimeSettings = useMemo(
    () => listRuntimeSettings(config, db),
    [config, db, tick],
  )
  const fileLoopRows = useMemo(() => {
    const engine = new FileLoopEngine(db, runtimeConfig)
    return runtimeConfig.repos.map((repo) => ({
      repo: repo.repo,
      active: engine.getActiveSession(repo.repo),
      recent: engine.listSessions(repo.repo, 1)[0] ?? null,
    }))
  }, [db, runtimeConfig])

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
    }, effectivePollIntervalMs)
    return () => clearInterval(timer)
  }, [autoRefresh, effectivePollIntervalMs])

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
        const startupConfig = resolveConfigWithRuntimeSettings(config, db)
        const syncEngine = new SyncEngine(db, startupConfig)
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
  const stats = useMemo(
    () => loadTuiStats(db, { costModel: runtimeConfig.cost.model }),
    [db, runtimeConfig.cost.model, tick],
  )
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
    const maxIndex = Math.max(0, runtimeSettings.length - 1)
    setSelectedSettingIndex((current) => Math.max(0, Math.min(current, maxIndex)))
  }, [runtimeSettings.length])

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
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const result = await pollOnce(currentRuntimeConfig, db, dryRun, undefined, target)
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
    }, effectivePollIntervalMs)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [autoRefresh, effectivePollIntervalMs, enableBackgroundPoller, runPollCycle, startupReady])

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

  const moveSettingSelection = useCallback((direction: -1 | 1) => {
    const maxIndex = Math.max(0, runtimeSettings.length - 1)
    setSelectedSettingIndex((current) => Math.max(0, Math.min(maxIndex, current + direction)))
  }, [runtimeSettings.length])

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

  const runRetry = useCallback(async () => {
    await runAction('retry', async () => {
      if (!selectedIssue) throw new Error('No issue selected')
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const engine = new RetryEngine(db, currentRuntimeConfig)
      await engine.retry(selectedIssue.repo, selectedIssue.issue_number, {
        immediate: false,
        resetPlan: true,
        resetBranch: true,
        dryRun,
        strategyOverride: manualStrategy ?? undefined,
        actor: 'tui',
      })
      if (!dryRun && enableBackgroundPoller) {
        await runPollCycle('manual', selectedIssue)
      }
      return `queued fresh retry for ${selectedIssue.repo}#${selectedIssue.issue_number}${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, enableBackgroundPoller, manualStrategy, runAction, runPollCycle, selectedIssue])

  const runSync = useCallback(async () => {
    await runAction('sync', async () => {
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const engine = new SyncEngine(db, currentRuntimeConfig)
      const result = await engine.reconcile(dryRun)
      return `${result.reconciledRuns.length} reconciled, ${result.labelCorrections.length} label fixes, ${result.expiredLeases} expired lease(s), ${result.orphanedWorktrees.length} orphaned worktree(s)${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, runAction])

  const runCleanup = useCallback(async () => {
    await runAction('cleanup', async () => {
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const engine = new CleanupEngine(db, currentRuntimeConfig)
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
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const targetRepo = activeTab === 'projects'
        ? currentRuntimeConfig.repos[selectedProjectIndex]?.repo
        : selectedIssue?.repo ?? currentRuntimeConfig.repos[0]?.repo

      if (!targetRepo) {
        throw new Error('No repositories configured')
      }

      const engine = new LabelsInitEngine(currentRuntimeConfig)
      const result = await engine.run({
        targetRepo,
        dryRun,
      })
      return `${targetRepo}: ${formatLabelsInitSummary(result)}`
    })
  }, [activeTab, config, dryRun, runAction, selectedIssue, selectedProjectIndex])

  const runFileLoopStart = useCallback(async () => {
    await runAction('file-loop-start', async () => {
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const repoConfig = currentRuntimeConfig.repos[selectedProjectIndex]
      if (!repoConfig) throw new Error('No repository selected')
      if (dryRun) {
        return `[dry-run] would start file-loop for ${repoConfig.repo}`
      }
      const engine = new FileLoopEngine(db, currentRuntimeConfig)
      const session = engine.startSession(repoConfig)
      if (enableBackgroundPoller) {
        await runPollCycle('manual')
      }
      return `started file-loop session ${session.id} for ${repoConfig.repo}`
    })
  }, [config, db, dryRun, enableBackgroundPoller, runAction, runPollCycle, selectedProjectIndex])

  const runFileLoopStop = useCallback(async () => {
    await runAction('file-loop-stop', async () => {
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const repoConfig = currentRuntimeConfig.repos[selectedProjectIndex]
      if (!repoConfig) throw new Error('No repository selected')
      if (dryRun) {
        return `[dry-run] would stop file-loop for ${repoConfig.repo}`
      }
      const engine = new FileLoopEngine(db, currentRuntimeConfig)
      const session = engine.stopSession(repoConfig.repo)
      if (enableBackgroundPoller) {
        await runPollCycle('manual')
      }
      return `requested stop for file-loop session ${session.id} on ${repoConfig.repo}`
    })
  }, [config, db, dryRun, enableBackgroundPoller, runAction, runPollCycle, selectedProjectIndex])

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
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const repoConfig = currentRuntimeConfig.repos.find((r) => r.repo === target.repo)
      if (!repoConfig) throw new Error(`Repo not found in config: ${target.repo}`)
      const forge = createForgeAdapter(repoConfig, currentRuntimeConfig)
      let botUser = ''
      try {
        const auth = await forge.validateAuth()
        botUser = auth.user
      } catch {
        // Best effort only.
      }
      const result = await queueRebase(db, forge, repoConfig, target.issue_number, botUser, {
        strategyOverride: manualStrategy ?? undefined,
        actor: 'tui',
      })
      if (!dryRun && result.queued && enableBackgroundPoller) {
        await runPollCycle('manual', target)
      }
      return `${target.repo}#${target.issue_number}: ${result.reason}`
    })
  }, [config, db, dryRun, enableBackgroundPoller, issues, manualStrategy, runAction, runPollCycle, selectedIssue])

  const runContinue = useCallback(async () => {
    await runAction('continue', async () => {
      const target = selectedIssue ?? issues.find((issue) => issue.status === 'blocked' || issue.status === 'review_ready' || issue.status === 'error')
      if (!target) throw new Error('No issue selected')
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const repoConfig = currentRuntimeConfig.repos.find((r) => r.repo === target.repo)
      if (!repoConfig) throw new Error(`Repo not found in config: ${target.repo}`)
      const forge = createForgeAdapter(repoConfig, currentRuntimeConfig)
      let botUser = ''
      try {
        const auth = await forge.validateAuth()
        botUser = auth.user
      } catch {
        // Best effort only.
      }
      const result = await queueContinue(db, forge, repoConfig, target.issue_number, botUser, {
        dryRun,
        strategyOverride: manualStrategy ?? undefined,
        actor: 'tui',
      })
      if (!dryRun && result.queued && enableBackgroundPoller) {
        await runPollCycle('manual', target)
      }
      return `${target.repo}#${target.issue_number}: ${result.reason}${dryRun ? ' (dry-run)' : ''}`
    })
  }, [config, db, dryRun, enableBackgroundPoller, issues, manualStrategy, runAction, runPollCycle, selectedIssue])

  const runDeleteEntry = useCallback(async () => {
    await runAction('delete-entry', async () => {
      if (!selectedIssue) throw new Error('No issue selected')
      const currentRuntimeConfig = resolveConfigWithRuntimeSettings(config, db)
      const engine = new DeleteIssueEntryEngine(db, currentRuntimeConfig)
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

  const runCostOverride = useCallback(async () => {
    if (!selectedIssue) {
      setStatusLine('No issue selected')
      return
    }
    await runAction('cost-override', async () => {
      // TUI grants a deterministic headroom boost: double the current per-run
      // cap. For a bespoke amount, use CLI `night-orch cost-override` or MCP.
      const override = Math.max(
        config.security.maxCostPerRunUsd * 2,
        (selectedIssue.estimated_cost_usd ?? 0) + config.security.maxCostPerRunUsd,
      )
      const result = setIssueCostOverride(
        db,
        selectedIssue.repo,
        selectedIssue.issue_number,
        override,
      )
      return `${selectedIssue.repo}#${selectedIssue.issue_number}: cost override $${override.toFixed(2)} (daily cap bypassed for run ${result.runId})`
    })
  }, [config, db, runAction, selectedIssue])

  const runDailyCostOverride = useCallback(async () => {
    await runAction('daily-cost-override', async () => {
      // Deterministic headroom boost: double today's effective daily cap.
      // For a bespoke amount, use CLI `night-orch daily-cost-override` or MCP.
      const override = config.security.maxDailyCostUsd * 2
      const result = setDailyCostCapOverride(db, override)
      return `daily cap override for ${result.date}: $${override.toFixed(2)} (auto-expires at 00:00 UTC)`
    })
  }, [config, db, runAction])

  const runSetSetting = useCallback(async (nextValue: unknown) => {
    const target = runtimeSettings[selectedSettingIndex]
    if (!target) {
      setStatusLine('No setting selected')
      return
    }
    if (!target.mutable) {
      setStatusLine(`"${target.key}" is read-only at runtime`)
      return
    }

    await runAction('setting-set', async () => {
      const result = setRuntimeSettingOverride(config, db, target.key, nextValue, 'tui')
      return `${result.setting.key} => ${formatSettingValue(result.setting.effectiveValue)}`
    })
  }, [config, db, runAction, runtimeSettings, selectedSettingIndex])

  const runClearSetting = useCallback(async () => {
    const target = runtimeSettings[selectedSettingIndex]
    if (!target) {
      setStatusLine('No setting selected')
      return
    }
    if (!target.mutable) {
      setStatusLine(`"${target.key}" is read-only at runtime`)
      return
    }

    await runAction('setting-unset', async () => {
      const result = clearRuntimeSettingOverride(config, db, target.key)
      return `${result.setting.key} => ${formatSettingValue(result.setting.effectiveValue)} (${result.setting.source})`
    })
  }, [config, db, runAction, runtimeSettings, selectedSettingIndex])

  const runAdjustSelectedSetting = useCallback(async (direction: -1 | 1) => {
    const target = runtimeSettings[selectedSettingIndex]
    if (!target) {
      setStatusLine('No setting selected')
      return
    }
    if (!target.mutable) {
      setStatusLine(`"${target.key}" is read-only at runtime`)
      return
    }
    if (target.type !== 'number') {
      if (target.type === 'boolean') {
        setStatusLine(`"${target.key}" is boolean. Use space to toggle.`)
      } else if (target.type === 'json') {
        setStatusLine(`"${target.key}" is JSON. Use CLI/Web/MCP to set a value.`)
      } else {
        setStatusLine(`"${target.key}" is text. Use CLI/Web/MCP to set a value.`)
      }
      return
    }

    const current = target.effectiveValue
    if (typeof current !== 'number') {
      setStatusLine(`"${target.key}" has non-numeric effective value`)
      return
    }
    const step = target.step ?? 1
    const min = target.min ?? Number.NEGATIVE_INFINITY
    const max = target.max ?? Number.POSITIVE_INFINITY
    const next = Math.max(min, Math.min(max, current + direction * step))
    if (next === current) {
      setStatusLine(`"${target.key}" already at bound`)
      return
    }

    await runSetSetting(next)
  }, [runSetSetting, runtimeSettings, selectedSettingIndex])

  const runToggleSelectedSetting = useCallback(async () => {
    const target = runtimeSettings[selectedSettingIndex]
    if (!target) {
      setStatusLine('No setting selected')
      return
    }
    if (!target.mutable) {
      setStatusLine(`"${target.key}" is read-only at runtime`)
      return
    }
    if (target.type !== 'boolean') {
      if (target.type === 'number') {
        setStatusLine(`"${target.key}" is numeric. Use +/- to adjust.`)
      } else if (target.type === 'json') {
        setStatusLine(`"${target.key}" is JSON. Use CLI/Web/MCP to set a value.`)
      } else {
        setStatusLine(`"${target.key}" is text. Use CLI/Web/MCP to set a value.`)
      }
      return
    }

    const current = target.effectiveValue
    if (typeof current !== 'boolean') {
      setStatusLine(`"${target.key}" has non-boolean effective value`)
      return
    }

    await runSetSetting(!current)
  }, [runSetSetting, runtimeSettings, selectedSettingIndex])

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
    const focusedProjectDetail = activeTab === 'projects' && projectsViewMode === 'focus'
    if (cleanupConfirmPending && (input !== 'D' || focusedRunDetail || focusedProjectDetail)) {
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

    if (focusedProjectDetail && (key.escape || input === 'q')) {
      setProjectsViewMode('list')
      setStatusLine('Closed project detail')
      return
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

    if (activeTab === 'projects' && projectsViewMode === 'list') {
      if (key.downArrow || input === 'j') {
        setSelectedProjectIndex((current) => moveProjectSelection(current, 1, runtimeConfig.repos.length))
        return
      }
      if (key.upArrow || input === 'k') {
        setSelectedProjectIndex((current) => moveProjectSelection(current, -1, runtimeConfig.repos.length))
        return
      }
      if (input === 'o' || key.return) {
        if (runtimeConfig.repos.length > 0) {
          setProjectsViewMode('focus')
        }
        return
      }
    }

    if (activeTab === 'fileloop') {
      if (key.downArrow || input === 'j') {
        setSelectedProjectIndex((current) => moveProjectSelection(current, 1, runtimeConfig.repos.length))
        return
      }
      if (key.upArrow || input === 'k') {
        setSelectedProjectIndex((current) => moveProjectSelection(current, -1, runtimeConfig.repos.length))
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

    if (activeTab === 'settings') {
      if (key.downArrow || input === 'j') {
        moveSettingSelection(1)
        return
      }
      if (key.upArrow || input === 'k') {
        moveSettingSelection(-1)
        return
      }
      if (input === '+' || input === '=') {
        void runAdjustSelectedSetting(1)
        return
      }
      if (input === '-') {
        void runAdjustSelectedSetting(-1)
        return
      }
      if (input === 'u') {
        void runClearSetting()
        return
      }
      if (input === ' ') {
        void runToggleSelectedSetting()
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
      projectsViewMode,
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
    if (actionCommand === 'fileLoopStart') {
      void runFileLoopStart()
      return
    }
    if (actionCommand === 'fileLoopStop') {
      void runFileLoopStop()
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
    if (actionCommand === 'toggleStrategy') {
      setManualStrategy((current) => {
        const next = current === null ? 'merge' : current === 'merge' ? 'rebase' : null
        const label = next ?? 'repo default'
        setStatusLine(`Manual strategy: ${label}`)
        appendLog('info', `manual strategy set to ${label}`)
        return next
      })
      return
    }
    if (actionCommand === 'retry') {
      void runRetry()
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
    if (actionCommand === 'costOverride') {
      void runCostOverride()
      return
    }
    if (actionCommand === 'dailyCostOverride') {
      void runDailyCostOverride()
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
        pollIntervalMs={effectivePollIntervalMs}
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
          pollIntervalMs={effectivePollIntervalMs}
          lastRefreshAt={lastRefreshAt}
        />
      )}
      {activeTab === 'projects' && (
        <ProjectsView
          repos={runtimeConfig.repos}
          selectedIndex={selectedProjectIndex}
          workerProfiles={runtimeConfig.workerProfiles}
          globalGithubTokenEnv={runtimeConfig.github.tokenEnv}
          globalGithubApiBaseUrl={runtimeConfig.github.apiBaseUrl}
          mode={projectsViewMode}
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
      {activeTab === 'settings' && (
        <SettingsView
          settings={runtimeSettings}
          selectedIndex={selectedSettingIndex}
        />
      )}
      {activeTab === 'fileloop' && (
        <FileLoopView
          rows={fileLoopRows}
          selectedIndex={selectedProjectIndex}
        />
      )}

      <ActionsBar
        activeTab={activeTab}
        busy={actionState.busy}
        runsFocused={activeTab === 'runs' && runsViewMode === 'focus'}
        projectsFocused={activeTab === 'projects' && projectsViewMode === 'focus'}
        autoRefresh={autoRefresh}
        controlsEnabled={enableBackgroundPoller}
        manualStrategy={manualStrategy}
      />
    </Box>
  )
}
