import { type FormEvent, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { BudgetOverridesPanel } from './components/BudgetOverridesPanel.js'
import { DashboardHeader } from './components/DashboardHeader.js'
import { DashboardMetrics } from './components/DashboardMetrics.js'
import { DashboardNavigation } from './components/DashboardNavigation.js'
import { IssueDetailPage } from './components/IssueDetailPage.js'
import { OperationsPanel } from './components/OperationsPanel.js'
import { ProjectDetailPage } from './components/ProjectDetailPage.js'
import { ProjectsPage } from './components/ProjectsPage.js'
import { RunsPanel } from './components/RunsPanel.js'
import { SettingsPage } from './components/SettingsPage.js'
import { StatsPage } from './components/StatsPage.js'
import { UpdateProgressModal, GIT_STATE_ORDER, NPM_STATE_ORDER } from './components/UpdateProgressModal.js'
import { extractMessage } from './lib/format.js'
import { STATUS_BADGE_TONE } from './lib/run-tone.js'
import { asRunEventsPayload, mergeRunEvents } from './lib/run-events.js'
import { confirmSelfUpdate } from './lib/update-confirmation.js'
import {
  clearUpdateTransitionState,
  createUpdateTransitionState,
  isUpdateInProgress,
  pollAndApplyUpdateStatus,
  resolveImmediateUpdateStatusAfterAccept,
  type UpdateTransitionState,
} from './lib/update-status-flow.js'
import {
  type DashboardPage,
  type DashboardSnapshot,
  type ProjectsSnapshot,
  type RunListResult,
  type RunListView,
  type RuntimeSettingValue,
  type RunEvent,
  type RunSummary,
  type SettingsSnapshot,
  type SessionResponse,
  type UpdateStatus,
  type WsEnvelope,
} from './types/dashboard.js'

const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const MUTATION_INTENT_VALUE = 'mutate'
const WEB_AUTH_TOKEN_HEADER = 'x-night-orch-web-token'
const FRONTEND_BUILD_VERSION = import.meta.env.VITE_BUILD_VERSION ?? 'unknown'

const AUTO_POLL_COOLDOWN_MS = 60_000
const RUN_HISTORY_PAGE_SIZE = 20

interface RunOperationOptions {
  refreshAfterSuccess?: boolean
}

interface AppProps {
  activePage: DashboardPage
  issueDetailRunId?: string | null
  projectDetailRepo?: string | null
}

function decodeDetailId(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function formatRuntimeSettingDraft(value: RuntimeSettingValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.stringify(value)
  }
  return String(value)
}

export function App({
  activePage,
  issueDetailRunId = null,
  projectDetailRepo = null,
}: AppProps): ReactElement {
  const navigate = useNavigate()
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [projectsSnapshot, setProjectsSnapshot] = useState<ProjectsSnapshot | null>(null)
  const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isProjectsLoading, setIsProjectsLoading] = useState(true)
  const [isSettingsLoading, setIsSettingsLoading] = useState(true)
  const [socketConnected, setSocketConnected] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState('all')
  const [runsView, setRunsView] = useState<RunListView>('active')
  const [historyRuns, setHistoryRuns] = useState<RunSummary[]>([])
  const [isHistoryRunsLoading, setIsHistoryRunsLoading] = useState(false)
  const [isHistoryRunsLoadingMore, setIsHistoryRunsLoadingMore] = useState(false)
  const [historyRunsOffset, setHistoryRunsOffset] = useState(0)
  const [historyRunsHasMore, setHistoryRunsHasMore] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState('')
  const [runEvents, setRunEvents] = useState<RunEvent[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
  const [activeOperation, setActiveOperation] = useState<string | null>(null)
  const [isHeaderRefreshing, setIsHeaderRefreshing] = useState(false)
  const [webMutationToken, setWebMutationToken] = useState<string | null>(null)
  const [operationsEnabled, setOperationsEnabled] = useState(true)
  // Phase 2a — cookie auth state
  const [operatorAuthMode, setOperatorAuthMode] = useState(false)
  const [sessionAuthenticated, setSessionAuthenticated] = useState(false)
  const [loginDialogOpen, setLoginDialogOpen] = useState(false)
  const [loginTokenDraft, setLoginTokenDraft] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [settingsDrafts, setSettingsDrafts] = useState<Record<string, string>>({})
  const [dailyOverrideDraft, setDailyOverrideDraft] = useState('')
  const [costOverrideDraft, setCostOverrideDraft] = useState<{ repo: string; issueNumber: string; amount: string }>({
    repo: '',
    issueNumber: '',
    amount: '',
  })

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [updateStartedAt, setUpdateStartedAt] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const selectedStreamRunIdRef = useRef('')
  const subscribedRunRef = useRef('')
  const updateTransitionRef = useRef<UpdateTransitionState>(clearUpdateTransitionState())
  const lastPollTriggeredAtRef = useRef(Date.now())
  const operationsEnabledRef = useRef(operationsEnabled)
  const activeOperationRef = useRef(activeOperation)
  const webMutationTokenRef = useRef(webMutationToken)
  const historyRunsRequestRef = useRef(0)

  const repos = snapshot?.config.repos ?? []
  const allRuns = snapshot?.runs.runs ?? []
  const runningRuns = snapshot?.stats.overview.runningRuns ?? 0
  const queuedRuns = snapshot?.stats.overview.queuedRuns ?? 0
  const updateInProgress = isUpdateInProgress(updateStatus)

  const filteredRuns = useMemo(() => {
    if (selectedRepo === 'all') return allRuns
    return allRuns.filter((run) => run.repo === selectedRepo)
  }, [allRuns, selectedRepo])
  const displayedRuns = useMemo(
    () => (runsView === 'active' ? filteredRuns : historyRuns),
    [filteredRuns, historyRuns, runsView],
  )
  const runsPanelLoading = runsView === 'active' ? isLoading : isHistoryRunsLoading
  const runsPanelCanLoadMore = runsView !== 'active' && historyRunsHasMore
  const knownRunsById = useMemo(() => {
    const byRunId = new Map<string, RunSummary>()
    for (const run of allRuns) {
      byRunId.set(run.runId, run)
    }
    for (const run of historyRuns) {
      byRunId.set(run.runId, run)
    }
    return byRunId
  }, [allRuns, historyRuns])

  const decodedIssueDetailRunId = useMemo(
    () => decodeDetailId(issueDetailRunId),
    [issueDetailRunId],
  )
  const decodedProjectDetailRepo = useMemo(
    () => decodeDetailId(projectDetailRepo),
    [projectDetailRepo],
  )
  const selectedIssueDetailRun = useMemo(
    () => decodedIssueDetailRunId
      ? knownRunsById.get(decodedIssueDetailRunId) ?? null
      : null,
    [decodedIssueDetailRunId, knownRunsById],
  )
  const selectedStreamRunId = selectedIssueDetailRun?.hasRun ? selectedIssueDetailRun.runId : ''

  const currentState = useMemo(() => {
    if (updateInProgress) {
      return {
        label: `updating ${updateStatus?.state ?? 'starting'}`,
        toneClass: 'badge-warning',
      }
    }

    if (!socketConnected) {
      return {
        label: 'reconnecting',
        toneClass: 'badge-error',
      }
    }

    if (runningRuns > 0) {
      return {
        label: 'processing',
        toneClass: 'badge-success',
      }
    }

    if (queuedRuns > 0) {
      return {
        label: 'queued',
        toneClass: 'badge-info',
      }
    }

    return {
      label: 'idle',
      toneClass: 'badge-neutral',
    }
  }, [queuedRuns, runningRuns, socketConnected, updateInProgress, updateStatus?.state])

  const buildVersionLabel = useMemo(() => {
    const version = snapshot?.build?.version ?? FRONTEND_BUILD_VERSION
    const sha = snapshot?.build?.gitSha
    const isGit = snapshot?.build?.installMethod === 'git'
    if (isGit && sha) {
      return `v${version} · ${sha.slice(0, 8)}`
    }
    return `v${version}`
  }, [snapshot?.build])

  const loadDashboard = useCallback(async () => {
    const response = await fetch('/api/dashboard')
    if (!response.ok) {
      throw new Error(`Failed to load dashboard (${response.status})`)
    }
    const payload = await response.json() as DashboardSnapshot
    setSnapshot(payload)
  }, [])

  const loadHistoryRunsPage = useCallback(async (options: { append?: boolean; offset?: number } = {}) => {
    if (runsView === 'active') {
      return
    }

    const append = options.append ?? false
    const requestId = ++historyRunsRequestRef.current
    const offset = append ? (options.offset ?? 0) : 0
    if (append) {
      setIsHistoryRunsLoadingMore(true)
    } else {
      setHistoryRuns([])
      setHistoryRunsOffset(0)
      setHistoryRunsHasMore(false)
      setIsHistoryRunsLoading(true)
      setIsHistoryRunsLoadingMore(false)
    }

    try {
      const params = new URLSearchParams()
      if (selectedRepo !== 'all') {
        params.set('repo', selectedRepo)
      }
      params.set('view', runsView)
      params.set('limit', String(RUN_HISTORY_PAGE_SIZE))
      params.set('offset', String(offset))

      const response = await fetch(`/api/runs?${params.toString()}`)
      if (!response.ok) {
        throw new Error(`Failed to load runs (${response.status})`)
      }

      const payload = await response.json() as RunListResult
      if (requestId !== historyRunsRequestRef.current) {
        return
      }

      const hasMore = typeof payload.hasMore === 'boolean'
        ? payload.hasMore
        : payload.runs.length >= RUN_HISTORY_PAGE_SIZE
      const nextOffset = typeof payload.nextOffset === 'number'
        ? payload.nextOffset
        : offset + payload.runs.length

      setHistoryRuns((current) => {
        if (!append) {
          return payload.runs
        }
        const seen = new Set(current.map((run) => run.runId))
        const merged = [...current]
        for (const run of payload.runs) {
          if (seen.has(run.runId)) continue
          seen.add(run.runId)
          merged.push(run)
        }
        return merged
      })
      setHistoryRunsHasMore(hasMore)
      setHistoryRunsOffset(nextOffset)
    } catch (err) {
      if (requestId === historyRunsRequestRef.current) {
        setErrorMessage((err as Error).message)
      }
    } finally {
      if (requestId === historyRunsRequestRef.current) {
        setIsHistoryRunsLoading(false)
        setIsHistoryRunsLoadingMore(false)
      }
    }
  }, [runsView, selectedRepo])

  const readUpdateStatus = useCallback(async (): Promise<UpdateStatus | null> => {
    const response = await fetch('/api/update-status')
    if (!response.ok) {
      return null
    }
    return await response.json() as UpdateStatus
  }, [])

  const loadSessionToken = useCallback(async () => {
    const response = await fetch('/api/session')
    if (!response.ok) {
      throw new Error(`Failed to initialize web session (${response.status})`)
    }
    const payload = await response.json() as SessionResponse
    setOperationsEnabled(payload.operationsEnabled ?? true)
    const externalAuth = payload.requiresExternalAuth ?? (payload.mutationToken === null)
    setOperatorAuthMode(externalAuth)

    if (!externalAuth && payload.mutationToken) {
      // Loopback mode: server handed us the token directly, no login needed.
      setWebMutationToken(payload.mutationToken)
      setSessionAuthenticated(true)
      return
    }

    // Phase 2a: operator-auth mode. Check whether a valid session
    // cookie already exists from a prior login before prompting.
    try {
      const authStatus = await fetch('/api/auth/session')
      if (authStatus.ok) {
        const body = await authStatus.json() as { authenticated?: boolean }
        if (body.authenticated === true) {
          setSessionAuthenticated(true)
          return
        }
      }
    } catch {
      // Best-effort — fall through to the login dialog.
    }
    setSessionAuthenticated(false)
    setLoginDialogOpen(true)
  }, [])

  const submitLoginToken = useCallback(async () => {
    if (!loginTokenDraft.trim()) {
      setLoginError('Token is required.')
      return
    }
    setLoginBusy(true)
    setLoginError(null)
    try {
      const response = await fetch('/api/auth/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: MUTATION_INTENT_VALUE,
        },
        body: JSON.stringify({ token: loginTokenDraft.trim() }),
      })
      if (response.status === 204) {
        setSessionAuthenticated(true)
        setLoginDialogOpen(false)
        setLoginTokenDraft('')
        setLoginError(null)
        return
      }
      if (response.status === 401) {
        setLoginError('Invalid token. Check NIGHT_ORCH_WEB_AUTH_TOKEN on the server.')
        return
      }
      setLoginError(`Login failed (${response.status}).`)
    } catch (err) {
      setLoginError((err as Error).message)
    } finally {
      setLoginBusy(false)
    }
  }, [loginTokenDraft])

  const logoutSession = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: MUTATION_INTENT_VALUE,
        },
      })
    } catch {
      // Best-effort — even if the server errors we still clear local state.
    }
    setSessionAuthenticated(false)
    setLoginDialogOpen(true)
  }, [])

  const loadProjects = useCallback(async () => {
    const response = await fetch('/api/projects')
    if (!response.ok) {
      throw new Error(`Failed to load projects (${response.status})`)
    }
    const payload = await response.json() as ProjectsSnapshot
    setProjectsSnapshot(payload)
  }, [])

  const loadSettings = useCallback(async () => {
    const response = await fetch('/api/settings')
    if (!response.ok) {
      throw new Error(`Failed to load settings (${response.status})`)
    }
    const payload = await response.json() as SettingsSnapshot
    setSettingsSnapshot(payload)
    setSettingsDrafts(
      Object.fromEntries(
        payload.settings.map((setting) => [setting.key, formatRuntimeSettingDraft(setting.effectiveValue)]),
      ),
    )
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        setIsLoading(true)
        setIsProjectsLoading(true)
        setIsSettingsLoading(true)
        await Promise.all([loadDashboard(), loadSessionToken(), loadProjects(), loadSettings()])
      } catch (err) {
        setErrorMessage((err as Error).message)
      } finally {
        setIsLoading(false)
        setIsProjectsLoading(false)
        setIsSettingsLoading(false)
      }
    })()
  }, [loadDashboard, loadProjects, loadSessionToken, loadSettings])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const status = await readUpdateStatus()
        if (!status || cancelled) {
          return
        }
        if (isUpdateInProgress(status)) {
          updateTransitionRef.current = { startedAtMs: null, sawActiveState: true }
        } else {
          updateTransitionRef.current = clearUpdateTransitionState()
        }
        setUpdateStatus((prev) =>
          prev && !status.installMethod
            ? { ...status, installMethod: prev.installMethod }
            : status,
        )
      } catch {
        // Update status availability is best-effort.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [readUpdateStatus])

  useEffect(() => {
    setSelectedRepo((prev) => (prev === 'all' || repos.includes(prev) ? prev : 'all'))
  }, [repos])

  useEffect(() => {
    if (runsView === 'active') {
      historyRunsRequestRef.current += 1
      setHistoryRuns([])
      setHistoryRunsOffset(0)
      setHistoryRunsHasMore(false)
      setIsHistoryRunsLoading(false)
      setIsHistoryRunsLoadingMore(false)
      return
    }

    void loadHistoryRunsPage({ append: false, offset: 0 })
  }, [loadHistoryRunsPage, runsView])

  useEffect(() => {
    operationsEnabledRef.current = operationsEnabled
  }, [operationsEnabled])

  useEffect(() => {
    activeOperationRef.current = activeOperation
  }, [activeOperation])

  useEffect(() => {
    webMutationTokenRef.current = webMutationToken
  }, [webMutationToken])

  useEffect(() => {
    if (!decodedIssueDetailRunId) return
    setSelectedRunId(decodedIssueDetailRunId)
  }, [decodedIssueDetailRunId])

  useEffect(() => {
    let cancelled = false

    const connect = (): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const authQuery = webMutationToken
        ? `?token=${encodeURIComponent(webMutationToken)}`
        : ''
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws${authQuery}`)
      wsRef.current = socket

      socket.onopen = () => {
        if (cancelled) return
        setSocketConnected(true)
        socket.send(JSON.stringify({ type: 'refresh' }))
        const activeRun = selectedStreamRunIdRef.current
        if (activeRun) {
          socket.send(JSON.stringify({ type: 'subscribe-run-events', runId: activeRun, since: 0 }))
        }
      }

      socket.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data) as WsEnvelope
          if (envelope.type === 'snapshot' && envelope.payload) {
            setSnapshot(envelope.payload as DashboardSnapshot)
            return
          }

          if (envelope.type === 'run-events' && envelope.payload) {
            const payload = asRunEventsPayload(envelope.payload)
            if (!payload || payload.runId !== selectedStreamRunIdRef.current) {
              return
            }

            setRunEvents((previous) => mergeRunEvents(previous, payload.events))
            return
          }

          if (envelope.type === 'error' && envelope.error) {
            setFeedbackMessage(envelope.error)
          }
        } catch {
          // Ignore malformed websocket payloads.
        }
      }

      socket.onclose = () => {
        if (wsRef.current === socket) {
          wsRef.current = null
        }
        setSocketConnected(false)

        if (cancelled) return
        reconnectTimerRef.current = window.setTimeout(connect, 2000)
      }

      socket.onerror = () => {
        socket.close()
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [webMutationToken])

  useEffect(() => {
    selectedStreamRunIdRef.current = selectedStreamRunId
    setRunEvents([])

    const socket = wsRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      subscribedRunRef.current = selectedStreamRunId
      return
    }

    const previousRun = subscribedRunRef.current
    if (previousRun && previousRun !== selectedStreamRunId) {
      socket.send(JSON.stringify({ type: 'unsubscribe-run-events', runId: previousRun }))
    }

    if (selectedStreamRunId) {
      socket.send(JSON.stringify({ type: 'subscribe-run-events', runId: selectedStreamRunId, since: 0 }))
    }

    subscribedRunRef.current = selectedStreamRunId
  }, [selectedStreamRunId, socketConnected])

  const [serverUnreachable, setServerUnreachable] = useState(false)

  useEffect(() => {
    if (!updateInProgress) return

    let cancelled = false
    let consecutiveFailures = 0

    const pollUpdateStatus = async (): Promise<void> => {
      try {
        const nextTransition = await pollAndApplyUpdateStatus({
          fetchUpdateStatus: readUpdateStatus,
          transition: updateTransitionRef.current,
          onStatus: (status) => {
            if (cancelled) return
            consecutiveFailures = 0
            setServerUnreachable(false)
            setUpdateStatus((prev) =>
              prev && !status.installMethod
                ? { ...status, installMethod: prev.installMethod }
                : status,
            )
          },
          onError: (message) => {
            if (cancelled) return
            consecutiveFailures = 0
            setServerUnreachable(false)
            setErrorMessage(message)
          },
          onReload: () => {
            if (cancelled) return
            window.location.reload()
          },
        })
        if (!cancelled) {
          updateTransitionRef.current = nextTransition
        }
      } catch {
        // Server is down during the update (expected: supervisor drains
        // web server during pulling/building/restarting). After 2+
        // consecutive failures, mark as unreachable so the modal can
        // show a "server restarting" indicator and advance the displayed
        // stage past "draining".
        consecutiveFailures++
        if (!cancelled && consecutiveFailures >= 2) {
          setServerUnreachable(true)
          // Advance the displayed state through the workflow stages so
          // the user sees progress even while the server is down. We
          // infer the stage from how long the server has been unreachable.
          setUpdateStatus((prev) => {
            if (!prev) return prev
            const stateOrder = prev.installMethod === 'npm' ? NPM_STATE_ORDER : GIT_STATE_ORDER
            const currentIdx = stateOrder.indexOf(prev.state)
            if (currentIdx < 0 || currentIdx >= stateOrder.length - 1) return prev
            const elapsed = consecutiveFailures * 2 // ~2s per poll
            if (elapsed >= 4 * (currentIdx + 1)) {
              const nextState = stateOrder[currentIdx + 1]
              if (nextState) return { ...prev, state: nextState }
            }
            return prev
          })
        }
      }
    }

    void pollUpdateStatus()
    const interval = window.setInterval(() => {
      void pollUpdateStatus()
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [readUpdateStatus, updateInProgress])

  useEffect(() => {
    if (!updateStartedAt) return
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - updateStartedAt) / 1000))
    }, 1000)
    return () => window.clearInterval(interval)
  }, [updateStartedAt])

  const runOperation = useCallback(async (
    operationName: string,
    endpoint: string,
    payload: Record<string, unknown>,
    fallbackMessage: string,
    options?: RunOperationOptions,
  ): Promise<boolean> => {
    try {
      setActiveOperation(operationName)
      setErrorMessage(null)

      // Phase 2a: either a header token OR a valid session cookie
      // satisfies the mutation guard. In operator-auth mode we
      // expect the cookie to be present (the login dialog runs
      // before any mutation path); in loopback mode the server
      // hands us the header token at startup.
      if (!webMutationToken && !sessionAuthenticated) {
        setLoginDialogOpen(true)
        throw new Error('Log in first.')
      }
      if (!operationsEnabled) {
        throw new Error('Web operations are disabled by server policy.')
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: MUTATION_INTENT_VALUE,
      }
      if (webMutationToken) {
        headers[WEB_AUTH_TOKEN_HEADER] = webMutationToken
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      })

      // Phase 2a: a 401 in operator-auth mode usually means the
      // session cookie expired — re-prompt for the token instead of
      // bubbling a cryptic error.
      if (response.status === 401 && operatorAuthMode) {
        setSessionAuthenticated(false)
        setLoginDialogOpen(true)
        throw new Error('Session expired. Log in again.')
      }

      const body = await response.json() as Record<string, unknown>
      if (!response.ok) {
        const message = typeof body['error'] === 'string' ? body['error'] : `Operation failed (${response.status})`
        throw new Error(message)
      }

      const message = extractMessage(body) ?? fallbackMessage
      setFeedbackMessage(message)
      if (options?.refreshAfterSuccess ?? true) {
        await Promise.all([loadDashboard(), loadSettings()])
        if (runsView !== 'active') {
          await loadHistoryRunsPage({ append: false, offset: 0 })
        }
      }
      return true
    } catch (err) {
      setErrorMessage((err as Error).message)
      return false
    } finally {
      setActiveOperation(null)
    }
  }, [
    loadDashboard,
    loadHistoryRunsPage,
    loadSettings,
    operationsEnabled,
    operatorAuthMode,
    runsView,
    sessionAuthenticated,
    webMutationToken,
  ])

  const refreshDashboardData = useCallback(async () => {
    try {
      setIsHeaderRefreshing(true)
      setErrorMessage(null)
      const refreshTasks: Array<Promise<void>> = [
        loadDashboard(),
        loadProjects(),
        loadSettings(),
      ]
      if (activePage === 'issues' && runsView !== 'active') {
        refreshTasks.push(loadHistoryRunsPage({ append: false, offset: 0 }))
      }
      await Promise.all(refreshTasks)
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'refresh' }))
      }
    } catch (err) {
      setErrorMessage((err as Error).message)
    } finally {
      setIsHeaderRefreshing(false)
    }
  }, [activePage, loadDashboard, loadHistoryRunsPage, loadProjects, loadSettings, runsView])

  const triggerPoll = useCallback(() => {
    lastPollTriggeredAtRef.current = Date.now()
    void runOperation('poll', '/api/operations/poll', {}, 'Manual poll requested')
  }, [runOperation])

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return

      const cooldownElapsed = Date.now() - lastPollTriggeredAtRef.current >= AUTO_POLL_COOLDOWN_MS
      const canPoll = operationsEnabledRef.current
        && activeOperationRef.current === null
        && webMutationTokenRef.current !== null

      if (cooldownElapsed && canPoll) {
        triggerPoll()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [triggerPoll])

  const triggerSync = useCallback(() => {
    void runOperation('sync', '/api/operations/sync', {}, 'Sync completed')
  }, [runOperation])

  const triggerCleanup = useCallback(() => {
    void runOperation('cleanup', '/api/operations/cleanup', {}, 'Cleanup completed')
  }, [runOperation])

  const handleRunsViewChange = useCallback((nextView: RunListView) => {
    if (nextView === runsView) {
      return
    }
    if (nextView !== 'active') {
      setIsHistoryRunsLoading(true)
      setIsHistoryRunsLoadingMore(false)
    }
    setRunsView(nextView)
  }, [runsView])

  const navigateToPage = useCallback((page: DashboardPage) => {
    void navigate({ to: '/$page', params: { page } })
  }, [navigate])

  const openIssueDetail = useCallback((runId: string) => {
    setSelectedRunId(runId)
    void navigate({
      to: '/$page/$detailId',
      params: { page: 'issues', detailId: runId },
    })
  }, [navigate])

  const closeIssueDetail = useCallback(() => {
    void navigate({ to: '/$page', params: { page: 'issues' } })
  }, [navigate])

  const openProjectDetail = useCallback((repo: string) => {
    void navigate({
      to: '/$page/$detailId',
      params: { page: 'projects', detailId: repo },
    })
  }, [navigate])

  const closeProjectDetail = useCallback(() => {
    void navigate({ to: '/$page', params: { page: 'projects' } })
  }, [navigate])

  const submitUpdate = useCallback(async () => {
    const method = snapshot?.build?.installMethod
    const installMethod = method === 'git' || method === 'npm' ? method : 'unknown'
    if (!confirmSelfUpdate((message) => window.confirm(message), installMethod)) {
      return
    }

    const accepted = await runOperation(
      'update',
      '/api/operations/update',
      {},
      'Update initiated - pulling and rebuilding...',
      { refreshAfterSuccess: false },
    )
    if (!accepted) {
      return
    }

    updateTransitionRef.current = createUpdateTransitionState(Date.now())
    setUpdateStatus({
      state: 'draining',
      installMethod: method === 'git' || method === 'npm' ? method : undefined,
    })
    setUpdateStartedAt(Date.now())
    setElapsedSeconds(0)

    try {
      const status = await readUpdateStatus()
      if (!status) {
        return
      }
      const immediateStatus = resolveImmediateUpdateStatusAfterAccept(status)
      if (immediateStatus) {
        updateTransitionRef.current = {
          startedAtMs: updateTransitionRef.current.startedAtMs,
          sawActiveState: true,
        }
        setUpdateStatus(immediateStatus)
      }
    } catch {
      // Ignore immediate read failures while update orchestration starts.
    }
  }, [readUpdateStatus, runOperation])

  const runIssueOperation = useCallback(async (
    run: RunSummary,
    options: {
      operationName: string
      endpoint: string
      confirmMessage: string
      fallbackMessage: string
      payload?: Record<string, unknown>
    },
  ) => {
    if (!window.confirm(options.confirmMessage)) {
      return
    }

    await runOperation(
      options.operationName,
      options.endpoint,
      {
        repo: run.repo,
        issueNumber: run.issue,
        ...options.payload,
      },
      options.fallbackMessage,
    )
  }, [runOperation])

  const triggerIssueRetry = useCallback((run: RunSummary) => {
    void runIssueOperation(run, {
      operationName: 'retry',
      endpoint: '/api/operations/retry',
      confirmMessage: `Queue fresh retry for ${run.repo}#${run.issue}?`,
      fallbackMessage: `Fresh retry queued for ${run.repo}#${run.issue}`,
    })
  }, [runIssueOperation])

  const triggerIssueRebase = useCallback((run: RunSummary) => {
    void runIssueOperation(run, {
      operationName: 'rebase',
      endpoint: '/api/operations/rebase',
      confirmMessage: `Queue rebase for ${run.repo}#${run.issue}?`,
      fallbackMessage: `Rebase queued for ${run.repo}#${run.issue}`,
    })
  }, [runIssueOperation])

  const triggerIssueContinue = useCallback((run: RunSummary) => {
    void runIssueOperation(run, {
      operationName: 'continue',
      endpoint: '/api/operations/continue',
      confirmMessage: `Queue continue pass for ${run.repo}#${run.issue}?`,
      fallbackMessage: `Continue pass queued for ${run.repo}#${run.issue}`,
    })
  }, [runIssueOperation])

  const triggerIssueDeleteEntry = useCallback((run: RunSummary, force: boolean) => {
    void runIssueOperation(run, {
      operationName: 'delete-entry',
      endpoint: '/api/operations/delete-entry',
      confirmMessage: force
        ? `Force delete local entry for ${run.repo}#${run.issue}? This can remove run-local state while shared issue state is still active elsewhere.`
        : `Delete local entry for ${run.repo}#${run.issue}?`,
      fallbackMessage: force
        ? `Force-deleted local entry for ${run.repo}#${run.issue}`
        : `Deleted local entry for ${run.repo}#${run.issue}`,
      payload: {
        force,
      },
    })
  }, [runIssueOperation])

  const triggerIssueResetCost = useCallback((run: RunSummary) => {
    void runIssueOperation(run, {
      operationName: 'cost-reset',
      endpoint: '/api/operations/cost-reset',
      confirmMessage: `Reset accumulated costs for ${run.repo}#${run.issue}? If cost-blocked, it will be re-queued.`,
      fallbackMessage: `Reset costs for ${run.repo}#${run.issue}`,
    })
  }, [runIssueOperation])

  const triggerProjectLabelsInit = useCallback((repo: string) => {
    if (!window.confirm(`Bootstrap orchestration labels for ${repo}?`)) {
      return
    }
    void runOperation(
      'labels-init',
      '/api/operations/labels-init',
      {
        repo,
      },
      `Labels initialized for ${repo}`,
    )
  }, [runOperation])

  const applySetting = useCallback(async (key: string) => {
    const value = settingsDrafts[key]
    if (value === undefined) {
      setErrorMessage(`No draft value found for ${key}`)
      return
    }

    await runOperation(
      `setting:set:${key}`,
      '/api/operations/settings/set',
      { key, value },
      `Updated ${key}`,
    )
  }, [runOperation, settingsDrafts])

  const clearSetting = useCallback(async (key: string) => {
    await runOperation(
      `setting:clear:${key}`,
      '/api/operations/settings/clear',
      { key },
      `Cleared override for ${key}`,
    )
  }, [runOperation])

  const submitDailyCostOverride = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const amount = Number.parseFloat(dailyOverrideDraft)
    if (!Number.isFinite(amount) || amount <= 0) {
      setErrorMessage('Daily override requires a positive number (USD)')
      return
    }

    await runOperation(
      'daily-cost-override:set',
      '/api/operations/daily-cost-override/set',
      { amountUsd: amount },
      `Raised today's daily cap to $${amount.toFixed(2)}`,
    )
  }, [dailyOverrideDraft, runOperation])

  const clearDailyCostOverride = useCallback(async () => {
    await runOperation(
      'daily-cost-override:clear',
      '/api/operations/daily-cost-override/clear',
      {},
      "Cleared today's daily cap override",
    )
  }, [runOperation])

  const submitDailyCostReset = useCallback(async () => {
    if (!window.confirm("Reset today's accumulated cost counters? Cost-blocked runs will be re-queued.")) {
      return
    }
    await runOperation(
      'daily-cost-reset',
      '/api/operations/daily-cost-reset',
      {},
      "Reset today's daily costs and resumed cost-blocked runs",
    )
  }, [runOperation])

  const submitCostOverride = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const issueNumber = Number.parseInt(costOverrideDraft.issueNumber, 10)
    const amount = Number.parseFloat(costOverrideDraft.amount)
    if (!costOverrideDraft.repo || !Number.isFinite(issueNumber) || issueNumber <= 0) {
      setErrorMessage('Per-issue override requires a repo and a positive issue number')
      return
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setErrorMessage('Per-issue override requires a positive amount (USD)')
      return
    }

    await runOperation(
      'cost-override:set',
      '/api/operations/cost-override/set',
      { repo: costOverrideDraft.repo, issueNumber, amountUsd: amount },
      `Set cost override for ${costOverrideDraft.repo}#${issueNumber} to $${amount.toFixed(2)}`,
    )
  }, [costOverrideDraft, runOperation])

  const clearCostOverride = useCallback(async () => {
    const issueNumber = Number.parseInt(costOverrideDraft.issueNumber, 10)
    if (!costOverrideDraft.repo || !Number.isFinite(issueNumber) || issueNumber <= 0) {
      setErrorMessage('Clearing a per-issue override requires a repo and a positive issue number')
      return
    }

    await runOperation(
      'cost-override:clear',
      '/api/operations/cost-override/clear',
      { repo: costOverrideDraft.repo, issueNumber },
      `Cleared cost override for ${costOverrideDraft.repo}#${issueNumber}`,
    )
  }, [costOverrideDraft, runOperation])

  const isIssueDetailScreen = activePage === 'issues' && decodedIssueDetailRunId !== null
  const isProjectDetailScreen = activePage === 'projects' && decodedProjectDetailRepo !== null

  return (
    <main data-theme="black" className="min-h-screen bg-orch-admin">
      {loginDialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="norch-login-title"
        >
          <div className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <h2 id="norch-login-title" className="text-base font-semibold text-slate-100">
              Sign in
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Enter the <code className="font-mono">NIGHT_ORCH_WEB_AUTH_TOKEN</code> configured on the server.
              The browser will keep you signed in via an HttpOnly cookie for 7 days.
            </p>
            <input
              type="password"
              autoFocus
              autoComplete="off"
              value={loginTokenDraft}
              onChange={(e) => setLoginTokenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !loginBusy) void submitLoginToken()
              }}
              className="mt-3 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-orch-accent focus:outline-none"
              placeholder="Paste token here"
            />
            {loginError && (
              <p className="mt-2 text-xs text-rose-400" role="alert">
                {loginError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={loginBusy}
                onClick={() => {
                  void submitLoginToken()
                }}
                className="rounded bg-orch-accent px-3 py-2 text-sm font-medium text-slate-950 hover:bg-orch-accent/90 disabled:opacity-50"
              >
                {loginBusy ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          </div>
        </div>
      )}
      <DashboardHeader
        currentStateLabel={currentState.label}
        currentStateToneClass={currentState.toneClass}
        isWorking={runningRuns > 0 || activeOperation !== null || updateInProgress}
        socketConnected={socketConnected}
        lastRefreshAt={snapshot?.generatedAt ?? null}
        pollIntervalSeconds={snapshot?.config.pollIntervalSeconds ?? null}
        reposCount={repos.length}
        activeRuns={snapshot?.status.activeRuns ?? 0}
        runningRuns={runningRuns}
        queuedRuns={queuedRuns}
        operationsEnabled={operationsEnabled}
        activeOperation={activeOperation}
        isRefreshing={isHeaderRefreshing}
        onRefresh={() => {
          void refreshDashboardData()
        }}
        onPoll={triggerPoll}
        onSync={triggerSync}
        onCleanup={triggerCleanup}
        onGoToSettings={() => {
          navigateToPage('settings')
        }}
        // Phase 2a: only show the logout button when we're in
        // cookie-auth mode (loopback mode has no login flow to log
        // out of).
        onLogout={operatorAuthMode && sessionAuthenticated ? () => { void logoutSession() } : undefined}
      />

      <div className="mx-auto flex w-full max-w-[1550px] flex-col gap-5 px-4 pb-24 pt-5 sm:px-6 md:pb-6 lg:px-8">
        {errorMessage && (
          <div className="alert alert-error shadow-sm">
            <span>{errorMessage}</span>
          </div>
        )}
        {feedbackMessage && (
          <div className="alert alert-info shadow-sm">
            <span>{feedbackMessage}</span>
          </div>
        )}

        <div className="grid gap-5 md:grid-cols-[auto_minmax(0,1fr)] md:items-stretch md:gap-0">
          <DashboardNavigation activePage={activePage} onPageChange={navigateToPage} />

          <div className="flex min-w-0 flex-col gap-5 md:pl-6">
            {activePage === 'issues' && (
              isIssueDetailScreen ? (
                <IssueDetailPage
                  run={selectedIssueDetailRun}
                  runId={decodedIssueDetailRunId ?? ''}
                  runEvents={runEvents}
                  operationsEnabled={operationsEnabled}
                  activeOperation={activeOperation}
                  onRetry={triggerIssueRetry}
                  onRebase={triggerIssueRebase}
                  onContinue={triggerIssueContinue}
                  onDeleteEntry={triggerIssueDeleteEntry}
                  onResetCost={triggerIssueResetCost}
                  onBack={closeIssueDetail}
                />
              ) : (
                <div className="flex flex-col gap-5">
                  <DashboardMetrics snapshot={snapshot} />

                  <section className="grid gap-5 xl:grid-cols-[1.65fr_1fr]">
                    <RunsPanel
                      isLoading={runsPanelLoading}
                      isLoadingMore={isHistoryRunsLoadingMore}
                      repos={repos}
                      selectedRepo={selectedRepo}
                      onSelectedRepoChange={setSelectedRepo}
                      runsView={runsView}
                      onRunsViewChange={handleRunsViewChange}
                      filteredRuns={displayedRuns}
                      canLoadMore={runsPanelCanLoadMore}
                      onLoadMore={() => {
                        void loadHistoryRunsPage({ append: true, offset: historyRunsOffset })
                      }}
                      selectedRunId={selectedRunId}
                      onOpenRun={openIssueDetail}
                      statusTone={STATUS_BADGE_TONE}
                    />

                    <OperationsPanel
                      operationsEnabled={operationsEnabled}
                      activeOperation={activeOperation}
                      updateStatus={updateStatus}
                      installMethod={snapshot?.build?.installMethod}
                      onUpdate={() => {
                        void submitUpdate()
                      }}
                    />
                  </section>
                </div>
              )
            )}

            {activePage === 'stats' && <StatsPage snapshot={snapshot} socketConnected={socketConnected} />}

            {activePage === 'projects' && (
              isProjectDetailScreen ? (
                <ProjectDetailPage
                  snapshot={projectsSnapshot}
                  repo={decodedProjectDetailRepo ?? ''}
                  isLoading={isProjectsLoading}
                  operationsEnabled={operationsEnabled}
                  activeOperation={activeOperation}
                  onLabelsInit={triggerProjectLabelsInit}
                  onBack={closeProjectDetail}
                />
              ) : (
                <ProjectsPage
                  snapshot={projectsSnapshot}
                  isLoading={isProjectsLoading}
                  onOpenRepo={openProjectDetail}
                />
              )
            )}

            {activePage === 'settings' && (
              <div className="flex flex-col gap-5">
                <BudgetOverridesPanel
                  baseDailyBudgetUsd={snapshot?.cost.dailyBudgetUsd ?? 0}
                  dailyBudgetOverrideUsd={snapshot?.cost.dailyBudgetOverrideUsd ?? null}
                  effectiveDailyBudgetUsd={snapshot?.cost.effectiveDailyBudgetUsd ?? snapshot?.cost.dailyBudgetUsd ?? 0}
                  todayCostUsd={snapshot?.status.dailyCostUsd ?? 0}
                  activeOperation={activeOperation}
                  dailyDraft={dailyOverrideDraft}
                  onDailyDraftChange={setDailyOverrideDraft}
                  onDailySubmit={(event) => { void submitDailyCostOverride(event) }}
                  onDailyClear={() => { void clearDailyCostOverride() }}
                  onDailyReset={() => { void submitDailyCostReset() }}
                  issueDraft={costOverrideDraft}
                  repos={repos}
                  onIssueDraftChange={(patch) => {
                    setCostOverrideDraft((current) => ({ ...current, ...patch }))
                  }}
                  onIssueSubmit={(event) => { void submitCostOverride(event) }}
                  onIssueClear={() => { void clearCostOverride() }}
                />
                <SettingsPage
                  settings={settingsSnapshot?.settings ?? []}
                  generatedAt={settingsSnapshot?.generatedAt ?? null}
                  isLoading={isSettingsLoading}
                  activeOperation={activeOperation}
                  drafts={settingsDrafts}
                  onDraftChange={(key, value) => {
                    setSettingsDrafts((current) => ({
                      ...current,
                      [key]: value,
                    }))
                  }}
                  onApply={(key) => {
                    void applySetting(key)
                  }}
                  onClear={(key) => {
                    void clearSetting(key)
                  }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 pb-16 pt-1 md:pb-2">
          <button
            type="button"
            className="btn btn-outline btn-sm border-primary/55 bg-base-200/45 text-primary hover:bg-primary/15"
            onClick={() => {
              window.location.reload()
            }}
          >
            UI reload
          </button>
          <span className="text-[10px] text-base-content/50">{buildVersionLabel}</span>
        </div>
      </div>

      {updateInProgress && updateStatus && (
        <UpdateProgressModal status={updateStatus} serverUnreachable={serverUnreachable} elapsedSeconds={elapsedSeconds} />
      )}
    </main>
  )
}
