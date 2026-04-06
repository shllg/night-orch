import { type FormEvent, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { BudgetOverridesPanel } from './components/BudgetOverridesPanel.js'
import { DashboardHeader } from './components/DashboardHeader.js'
import { DashboardMetrics } from './components/DashboardMetrics.js'
import { DashboardNavigation } from './components/DashboardNavigation.js'
import { OperationsPanel } from './components/OperationsPanel.js'
import { ProjectsPage } from './components/ProjectsPage.js'
import { RunEventStream } from './components/RunEventStream.js'
import { RunsPanel } from './components/RunsPanel.js'
import { SettingsPage } from './components/SettingsPage.js'
import { StatsPage } from './components/StatsPage.js'
import { UpdateProgressModal } from './components/UpdateProgressModal.js'
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
  type RunEvent,
  type SettingsSnapshot,
  type SessionResponse,
  type UpdateStatus,
  type WsEnvelope,
} from './types/dashboard.js'

const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const MUTATION_INTENT_VALUE = 'mutate'
const WEB_AUTH_TOKEN_HEADER = 'x-night-orch-web-token'
const FRONTEND_BUILD_VERSION = import.meta.env.VITE_BUILD_VERSION ?? 'unknown'
const FRONTEND_BUILD_GIT_SHA = import.meta.env.VITE_BUILD_GIT_SHA ?? 'unknown'

interface RunOperationOptions {
  refreshAfterSuccess?: boolean
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [projectsSnapshot, setProjectsSnapshot] = useState<ProjectsSnapshot | null>(null)
  const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isProjectsLoading, setIsProjectsLoading] = useState(true)
  const [isSettingsLoading, setIsSettingsLoading] = useState(true)
  const [socketConnected, setSocketConnected] = useState(false)
  const [activePage, setActivePage] = useState<DashboardPage>('issues')
  const [selectedRepo, setSelectedRepo] = useState('all')
  const [selectedProjectRepo, setSelectedProjectRepo] = useState('')
  const [selectedRunId, setSelectedRunId] = useState('')
  const [runEvents, setRunEvents] = useState<RunEvent[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
  const [activeOperation, setActiveOperation] = useState<string | null>(null)
  const [isHeaderRefreshing, setIsHeaderRefreshing] = useState(false)
  const [webMutationToken, setWebMutationToken] = useState<string | null>(null)
  const [operationsEnabled, setOperationsEnabled] = useState(true)
  const [settingsDrafts, setSettingsDrafts] = useState<Record<string, string>>({})
  const [dailyOverrideDraft, setDailyOverrideDraft] = useState('')
  const [costOverrideDraft, setCostOverrideDraft] = useState<{ repo: string; issueNumber: string; amount: string }>({
    repo: '',
    issueNumber: '',
    amount: '',
  })

  const [retryRepo, setRetryRepo] = useState('')
  const [retryIssueNumber, setRetryIssueNumber] = useState('')
  const [retryResetPlan, setRetryResetPlan] = useState(false)
  const [retryFresh, setRetryFresh] = useState(false)

  const [rebaseRepo, setRebaseRepo] = useState('')
  const [rebaseIssueNumber, setRebaseIssueNumber] = useState('')
  const [continueRepo, setContinueRepo] = useState('')
  const [continueIssueNumber, setContinueIssueNumber] = useState('')
  const [labelsInitRepo, setLabelsInitRepo] = useState('')

  const [deleteRepo, setDeleteRepo] = useState('')
  const [deleteIssueNumber, setDeleteIssueNumber] = useState('')
  const [deleteForce, setDeleteForce] = useState(false)

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const selectedStreamRunIdRef = useRef('')
  const subscribedRunRef = useRef('')
  const updateTransitionRef = useRef<UpdateTransitionState>(clearUpdateTransitionState())

  const repos = snapshot?.config.repos ?? []
  const allRuns = snapshot?.runs.runs ?? []
  const runningRuns = snapshot?.stats.overview.runningRuns ?? 0
  const queuedRuns = snapshot?.stats.overview.queuedRuns ?? 0
  const updateInProgress = isUpdateInProgress(updateStatus)

  const filteredRuns = useMemo(() => {
    if (selectedRepo === 'all') return allRuns
    return allRuns.filter((run) => run.repo === selectedRepo)
  }, [allRuns, selectedRepo])

  const selectedRun = useMemo(
    () => allRuns.find((run) => run.runId === selectedRunId) ?? null,
    [allRuns, selectedRunId],
  )
  const selectedStreamRunId = selectedRun?.hasRun ? selectedRun.runId : ''

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

  const loadDashboard = useCallback(async () => {
    const response = await fetch('/api/dashboard')
    if (!response.ok) {
      throw new Error(`Failed to load dashboard (${response.status})`)
    }
    const payload = await response.json() as DashboardSnapshot
    setSnapshot(payload)
  }, [])

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
    if (!payload.mutationToken) {
      throw new Error('Missing mutation token in session response')
    }
    setWebMutationToken(payload.mutationToken)
    setOperationsEnabled(payload.operationsEnabled ?? true)
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
        payload.settings.map((setting) => [setting.key, String(setting.effectiveValue)]),
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
        setUpdateStatus(status)
      } catch {
        // Update status availability is best-effort.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [readUpdateStatus])

  useEffect(() => {
    if (repos.length === 0) {
      setRetryRepo('')
      setRebaseRepo('')
      setContinueRepo('')
      setLabelsInitRepo('')
      setDeleteRepo('')
      return
    }

    setRetryRepo((prev) => (prev && repos.includes(prev) ? prev : repos[0] ?? ''))
    setRebaseRepo((prev) => (prev && repos.includes(prev) ? prev : repos[0] ?? ''))
    setContinueRepo((prev) => (prev && repos.includes(prev) ? prev : repos[0] ?? ''))
    setLabelsInitRepo((prev) => (prev && repos.includes(prev) ? prev : repos[0] ?? ''))
    setDeleteRepo((prev) => (prev && repos.includes(prev) ? prev : repos[0] ?? ''))
    setSelectedRepo((prev) => (prev === 'all' || repos.includes(prev) ? prev : 'all'))
  }, [repos])

  useEffect(() => {
    const projectRepos = projectsSnapshot?.repos.map((repo) => repo.repo) ?? []
    if (projectRepos.length === 0) {
      setSelectedProjectRepo('')
      return
    }
    setSelectedProjectRepo((prev) => (prev && projectRepos.includes(prev) ? prev : projectRepos[0] ?? ''))
  }, [projectsSnapshot])

  useEffect(() => {
    let cancelled = false

    const connect = (): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
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
  }, [])

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
            setUpdateStatus(status)
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
            const elapsed = consecutiveFailures * 2 // ~2s per poll
            if (elapsed >= 12 && prev.state === 'draining') return { ...prev, state: 'restarting' }
            if (elapsed >= 8 && prev.state === 'draining') return { ...prev, state: 'building' }
            if (elapsed >= 4 && prev.state === 'draining') return { ...prev, state: 'pulling' }
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

      if (!webMutationToken) {
        throw new Error('Web session is not initialized yet. Refresh the page and try again.')
      }
      if (!operationsEnabled) {
        throw new Error('Web operations are disabled by server policy.')
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: MUTATION_INTENT_VALUE,
          [WEB_AUTH_TOKEN_HEADER]: webMutationToken,
        },
        body: JSON.stringify(payload),
      })

      const body = await response.json() as Record<string, unknown>
      if (!response.ok) {
        const message = typeof body['error'] === 'string' ? body['error'] : `Operation failed (${response.status})`
        throw new Error(message)
      }

      const message = extractMessage(body) ?? fallbackMessage
      setFeedbackMessage(message)
      if (options?.refreshAfterSuccess ?? true) {
        await Promise.all([loadDashboard(), loadSettings()])
      }
      return true
    } catch (err) {
      setErrorMessage((err as Error).message)
      return false
    } finally {
      setActiveOperation(null)
    }
  }, [loadDashboard, loadSettings, operationsEnabled, webMutationToken])

  const refreshDashboardData = useCallback(async () => {
    try {
      setIsHeaderRefreshing(true)
      setErrorMessage(null)
      await Promise.all([loadDashboard(), loadProjects(), loadSettings()])
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'refresh' }))
      }
    } catch (err) {
      setErrorMessage((err as Error).message)
    } finally {
      setIsHeaderRefreshing(false)
    }
  }, [loadDashboard, loadProjects, loadSettings])

  const triggerPoll = useCallback(() => {
    void runOperation('poll', '/api/operations/poll', {}, 'Manual poll requested')
  }, [runOperation])

  const triggerSync = useCallback(() => {
    void runOperation('sync', '/api/operations/sync', {}, 'Sync completed')
  }, [runOperation])

  const triggerCleanup = useCallback(() => {
    void runOperation('cleanup', '/api/operations/cleanup', {}, 'Cleanup completed')
  }, [runOperation])

  const submitUpdate = useCallback(async () => {
    if (!confirmSelfUpdate((message) => window.confirm(message))) {
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
    setUpdateStatus({ state: 'draining' })

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

  const submitRetry = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const issueNumber = Number.parseInt(retryIssueNumber, 10)
    if (!retryRepo || !Number.isFinite(issueNumber) || issueNumber <= 0) {
      setErrorMessage('Retry requires a repo and a positive issue number')
      return
    }

    await runOperation(
      'retry',
      '/api/operations/retry',
      {
        repo: retryRepo,
        issueNumber,
        resetPlan: retryResetPlan,
        fresh: retryFresh,
      },
      `Retry queued for ${retryRepo}#${issueNumber}`,
    )
  }, [retryFresh, retryIssueNumber, retryRepo, retryResetPlan, runOperation])

  const submitRebase = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const issueNumber = Number.parseInt(rebaseIssueNumber, 10)
    if (!rebaseRepo || !Number.isFinite(issueNumber) || issueNumber <= 0) {
      setErrorMessage('Rebase requires a repo and a positive issue number')
      return
    }

    await runOperation(
      'rebase',
      '/api/operations/rebase',
      {
        repo: rebaseRepo,
        issueNumber,
      },
      `Rebase queued for ${rebaseRepo}#${issueNumber}`,
    )
  }, [rebaseIssueNumber, rebaseRepo, runOperation])

  const submitDeleteEntry = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const issueNumber = Number.parseInt(deleteIssueNumber, 10)
    if (!deleteRepo || !Number.isFinite(issueNumber) || issueNumber <= 0) {
      setErrorMessage('Delete entry requires a repo and a positive issue number')
      return
    }

    await runOperation(
      'delete-entry',
      '/api/operations/delete-entry',
      {
        repo: deleteRepo,
        issueNumber,
        force: deleteForce,
      },
      `Deleted local entry for ${deleteRepo}#${issueNumber}`,
    )
  }, [deleteForce, deleteIssueNumber, deleteRepo, runOperation])

  const submitLabelsInit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!labelsInitRepo) {
      setErrorMessage('Labels init requires a repo')
      return
    }

    await runOperation(
      'labels-init',
      '/api/operations/labels-init',
      {
        repo: labelsInitRepo,
      },
      `Labels initialized for ${labelsInitRepo}`,
    )
  }, [labelsInitRepo, runOperation])

  const submitContinue = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const issueNumber = Number.parseInt(continueIssueNumber, 10)
    if (!continueRepo || !Number.isFinite(issueNumber) || issueNumber <= 0) {
      setErrorMessage('Continue requires a repo and a positive issue number')
      return
    }

    await runOperation(
      'continue',
      '/api/operations/continue',
      {
        repo: continueRepo,
        issueNumber,
      },
      `Continue pass queued for ${continueRepo}#${issueNumber}`,
    )
  }, [continueIssueNumber, continueRepo, runOperation])

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

  return (
    <main data-theme="black" className="min-h-screen bg-orch-admin">
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
        frontendVersion={FRONTEND_BUILD_VERSION}
        frontendGitSha={FRONTEND_BUILD_GIT_SHA}
        backendVersion={snapshot?.build?.version ?? 'unknown'}
        backendGitSha={snapshot?.build?.gitSha ?? null}
        operationsEnabled={operationsEnabled}
        activeOperation={activeOperation}
        isRefreshing={isHeaderRefreshing}
        onRefresh={() => {
          void refreshDashboardData()
        }}
        onPoll={triggerPoll}
        onSync={triggerSync}
        onGoToSettings={() => {
          setActivePage('settings')
        }}
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
          <DashboardNavigation activePage={activePage} onPageChange={setActivePage} />

          <div className="flex min-w-0 flex-col gap-5 md:pl-6">
            {activePage === 'issues' && (
              <div className="flex flex-col gap-5">
                <DashboardMetrics snapshot={snapshot} />

                <section className="grid gap-5 xl:grid-cols-[1.65fr_1fr]">
                  <RunsPanel
                    isLoading={isLoading}
                    repos={repos}
                    selectedRepo={selectedRepo}
                    onSelectedRepoChange={setSelectedRepo}
                    filteredRuns={filteredRuns}
                    selectedRunId={selectedRunId}
                    onSelectedRunChange={setSelectedRunId}
                    statusTone={STATUS_BADGE_TONE}
                  />

                  <OperationsPanel
                    operationsEnabled={operationsEnabled}
                    activeOperation={activeOperation}
                    updateStatus={updateStatus}
                    repos={repos}
                    retryForm={{
                      repo: retryRepo,
                      issueNumber: retryIssueNumber,
                      resetPlan: retryResetPlan,
                      fresh: retryFresh,
                    }}
                    rebaseForm={{
                      repo: rebaseRepo,
                      issueNumber: rebaseIssueNumber,
                    }}
                    continueForm={{
                      repo: continueRepo,
                      issueNumber: continueIssueNumber,
                    }}
                    deleteEntryForm={{
                      repo: deleteRepo,
                      issueNumber: deleteIssueNumber,
                      force: deleteForce,
                    }}
                    labelsInitForm={{
                      repo: labelsInitRepo,
                    }}
                    onRetryFormChange={(patch) => {
                      if (patch.repo !== undefined) setRetryRepo(patch.repo)
                      if (patch.issueNumber !== undefined) setRetryIssueNumber(patch.issueNumber)
                      if (patch.resetPlan !== undefined) setRetryResetPlan(patch.resetPlan)
                      if (patch.fresh !== undefined) setRetryFresh(patch.fresh)
                    }}
                    onRebaseFormChange={(patch) => {
                      if (patch.repo !== undefined) setRebaseRepo(patch.repo)
                      if (patch.issueNumber !== undefined) setRebaseIssueNumber(patch.issueNumber)
                    }}
                    onContinueFormChange={(patch) => {
                      if (patch.repo !== undefined) setContinueRepo(patch.repo)
                      if (patch.issueNumber !== undefined) setContinueIssueNumber(patch.issueNumber)
                    }}
                    onDeleteEntryFormChange={(patch) => {
                      if (patch.repo !== undefined) setDeleteRepo(patch.repo)
                      if (patch.issueNumber !== undefined) setDeleteIssueNumber(patch.issueNumber)
                      if (patch.force !== undefined) setDeleteForce(patch.force)
                    }}
                    onLabelsInitFormChange={(patch) => {
                      if (patch.repo !== undefined) setLabelsInitRepo(patch.repo)
                    }}
                    onPoll={triggerPoll}
                    onSync={triggerSync}
                    onCleanup={triggerCleanup}
                    onLabelsInitSubmit={(event) => {
                      void submitLabelsInit(event)
                    }}
                    onRetrySubmit={(event) => {
                      void submitRetry(event)
                    }}
                    onRebaseSubmit={(event) => {
                      void submitRebase(event)
                    }}
                    onContinueSubmit={(event) => {
                      void submitContinue(event)
                    }}
                    onDeleteEntrySubmit={(event) => {
                      void submitDeleteEntry(event)
                    }}
                    onUpdate={() => {
                      void submitUpdate()
                    }}
                  />
                </section>

                <RunEventStream selectedRunId={selectedRunId} selectedRun={selectedRun} runEvents={runEvents} />
              </div>
            )}

            {activePage === 'stats' && <StatsPage snapshot={snapshot} socketConnected={socketConnected} />}

            {activePage === 'projects' && (
              <ProjectsPage
                snapshot={projectsSnapshot}
                isLoading={isProjectsLoading}
                selectedRepo={selectedProjectRepo}
                onSelectedRepoChange={setSelectedProjectRepo}
              />
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

        <div className="flex justify-center pb-16 pt-1 md:pb-2">
          <button
            type="button"
            className="btn btn-outline btn-sm border-primary/55 bg-base-200/45 text-primary hover:bg-primary/15"
            onClick={() => {
              window.location.reload()
            }}
          >
            UI reload
          </button>
        </div>
      </div>

      {updateInProgress && updateStatus && (
        <UpdateProgressModal status={updateStatus} serverUnreachable={serverUnreachable} />
      )}
    </main>
  )
}
