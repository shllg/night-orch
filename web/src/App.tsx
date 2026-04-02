import { type FormEvent, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'

type RunStatus = 'queued' | 'running' | 'blocked' | 'review_ready' | 'error' | 'completed'

interface RunListResult {
  count: number
  runs: RunSummary[]
}

interface RunSummary {
  runId: string
  repo: string
  issue: number
  status: RunStatus
  phase: string | null
  iterations: number
  costUsd: number
  startedAt: string | null
  endedAt: string | null
}

interface DashboardSnapshot {
  generatedAt: string
  status: {
    activeRuns: number
    dailyCostUsd: number
  }
  runs: RunListResult
  cost: {
    dailyBudgetUsd: number
  }
  config: {
    repos: string[]
    pollIntervalSeconds: number
  }
  stats: {
    throughput: {
      runs24h: number
      successRate7d: number
    }
    overview: {
      queuedRuns: number
      runningRuns: number
      reviewReadyRuns: number
      blockedRuns: number
      errorRuns: number
    }
  }
}

interface RunEvent {
  id: number
  runId: string
  phase: string
  role: string
  type: string
  timestamp: string
  data: Record<string, unknown> | null
}

interface RunEventsPayload {
  runId: string
  events: RunEvent[]
  lastEventId: number
}

interface WsEnvelope {
  type: string
  payload?: unknown
  error?: string
}

interface SessionResponse {
  mutationToken: string
  operationsEnabled?: boolean
}

const STATUS_TONE: Record<RunStatus, string> = {
  queued: 'badge-info',
  running: 'badge-warning',
  blocked: 'badge-secondary',
  review_ready: 'badge-success',
  error: 'badge-error',
  completed: 'badge-neutral',
}
const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const MUTATION_INTENT_VALUE = 'mutate'
const WEB_AUTH_TOKEN_HEADER = 'x-night-orch-web-token'

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [socketConnected, setSocketConnected] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState('all')
  const [selectedRunId, setSelectedRunId] = useState('')
  const [runEvents, setRunEvents] = useState<RunEvent[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
  const [activeOperation, setActiveOperation] = useState<string | null>(null)
  const [webMutationToken, setWebMutationToken] = useState<string | null>(null)
  const [operationsEnabled, setOperationsEnabled] = useState(true)

  const [retryRepo, setRetryRepo] = useState('')
  const [retryIssueNumber, setRetryIssueNumber] = useState('')
  const [retryResetPlan, setRetryResetPlan] = useState(false)
  const [retryFresh, setRetryFresh] = useState(false)

  const [rebaseRepo, setRebaseRepo] = useState('')
  const [rebaseIssueNumber, setRebaseIssueNumber] = useState('')

  const [deleteRepo, setDeleteRepo] = useState('')
  const [deleteIssueNumber, setDeleteIssueNumber] = useState('')
  const [deleteForce, setDeleteForce] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const selectedRunIdRef = useRef('')
  const subscribedRunRef = useRef('')

  const repos = snapshot?.config.repos ?? []
  const allRuns = snapshot?.runs.runs ?? []

  const filteredRuns = useMemo(() => {
    if (selectedRepo === 'all') return allRuns
    return allRuns.filter((run) => run.repo === selectedRepo)
  }, [allRuns, selectedRepo])

  const selectedRun = useMemo(
    () => allRuns.find((run) => run.runId === selectedRunId) ?? null,
    [allRuns, selectedRunId],
  )

  const loadDashboard = useCallback(async () => {
    const response = await fetch('/api/dashboard')
    if (!response.ok) {
      throw new Error(`Failed to load dashboard (${response.status})`)
    }
    const payload = await response.json() as DashboardSnapshot
    setSnapshot(payload)
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

  useEffect(() => {
    void (async () => {
      try {
        setIsLoading(true)
        await Promise.all([loadDashboard(), loadSessionToken()])
      } catch (err) {
        setErrorMessage((err as Error).message)
      } finally {
        setIsLoading(false)
      }
    })()
  }, [loadDashboard, loadSessionToken])

  useEffect(() => {
    if (repos.length === 0) {
      setRetryRepo('')
      setRebaseRepo('')
      setDeleteRepo('')
      return
    }

    setRetryRepo((prev) => (prev && repos.includes(prev) ? prev : repos[0] ?? ''))
    setRebaseRepo((prev) => (prev && repos.includes(prev) ? prev : repos[0] ?? ''))
    setDeleteRepo((prev) => (prev && repos.includes(prev) ? prev : repos[0] ?? ''))
    setSelectedRepo((prev) => (prev === 'all' || repos.includes(prev) ? prev : 'all'))
  }, [repos])

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
        const activeRun = selectedRunIdRef.current
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
            if (!payload || payload.runId !== selectedRunIdRef.current) {
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
    selectedRunIdRef.current = selectedRunId
    setRunEvents([])

    const socket = wsRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      subscribedRunRef.current = selectedRunId
      return
    }

    const previousRun = subscribedRunRef.current
    if (previousRun && previousRun !== selectedRunId) {
      socket.send(JSON.stringify({ type: 'unsubscribe-run-events', runId: previousRun }))
    }

    if (selectedRunId) {
      socket.send(JSON.stringify({ type: 'subscribe-run-events', runId: selectedRunId, since: 0 }))
    }

    subscribedRunRef.current = selectedRunId
  }, [selectedRunId, socketConnected])

  const runOperation = useCallback(async (
    operationName: string,
    endpoint: string,
    payload: Record<string, unknown>,
    fallbackMessage: string,
  ) => {
    try {
      setActiveOperation(operationName)
      setErrorMessage(null)

      if (!webMutationToken) {
        throw new Error('Web session is not initialized yet. Refresh the page and try again.')
      }
      if (!operationsEnabled) {
        throw new Error('Web operations are disabled in attach mode. Restart with --standalone to enable them.')
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
      await loadDashboard()
    } catch (err) {
      setErrorMessage((err as Error).message)
    } finally {
      setActiveOperation(null)
    }
  }, [loadDashboard, operationsEnabled, webMutationToken])

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

  return (
    <main data-theme="business" className="min-h-screen bg-orch-admin px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5">
        <header className="navbar rounded-box border border-base-300/60 bg-base-200/60 px-4 py-3 shadow-panel backdrop-blur sm:px-5">
          <div className="flex-1">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-info/80">night-orch</p>
              <h1 className="text-2xl font-semibold text-base-content sm:text-3xl">Web Control Center</h1>
              <p className="text-sm text-base-content/70">
                Poll interval {snapshot?.config.pollIntervalSeconds ?? '-'}s
              </p>
            </div>
          </div>
          <div className="flex-none">
            <div className="flex flex-wrap justify-end gap-2">
              <span className={`badge badge-outline gap-1 ${socketConnected ? 'badge-success' : 'badge-error'}`}>
                {socketConnected ? 'Live stream online' : 'Reconnecting stream'}
              </span>
              <span className="badge badge-neutral badge-outline">
                Last refresh {snapshot ? formatTimestamp(snapshot.generatedAt) : '--'}
              </span>
            </div>
          </div>
        </header>

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

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Active" value={snapshot?.status.activeRuns ?? 0} accent="cyan" />
          <MetricCard label="Running" value={snapshot?.stats.overview.runningRuns ?? 0} accent="amber" />
          <MetricCard
            label="Daily Cost"
            value={`$${formatMoney(snapshot?.status.dailyCostUsd ?? 0)}`}
            accent="emerald"
            subValue={`Budget $${formatMoney(snapshot?.cost.dailyBudgetUsd ?? 0)}`}
          />
          <MetricCard
            label="24h Throughput"
            value={snapshot?.stats.throughput.runs24h ?? 0}
            accent="sky"
            subValue={`${(snapshot?.stats.throughput.successRate7d ?? 0).toFixed(1)}% success (7d)`}
          />
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.65fr_1fr]">
          <div className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
            <div className="card-body p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="card-title text-lg">Runs</h2>
                  <p className="text-xs text-base-content/70">Live and recent execution history.</p>
                </div>
                <label className="form-control max-w-sm">
                  <div className="label py-0 pb-1">
                    <span className="label-text text-xs uppercase tracking-wide text-base-content/70">
                      Repo Filter
                    </span>
                  </div>
                  <select
                    className="select select-bordered select-sm w-full bg-base-100/80"
                    value={selectedRepo}
                    onChange={(event) => setSelectedRepo(event.target.value)}
                  >
                    <option value="all">All repos</option>
                    {repos.map((repo) => (
                      <option key={repo} value={repo}>{repo}</option>
                    ))}
                  </select>
                </label>
              </div>

              {isLoading ? (
                <div className="mt-4 space-y-2">
                  <div className="skeleton h-20 w-full" />
                  <div className="skeleton h-20 w-full" />
                </div>
              ) : filteredRuns.length === 0 ? (
                <div className="alert mt-4 border border-base-300/60 bg-base-100/70 text-sm">
                  <span>No runs for the current filter.</span>
                </div>
              ) : (
                <div className="mt-4 grid max-h-[540px] gap-3 overflow-y-auto pr-1">
                  {filteredRuns.map((run) => (
                    <button
                      key={run.runId}
                      type="button"
                      onClick={() => setSelectedRunId(run.runId)}
                      className={`card w-full border text-left transition-all ${
                        selectedRunId === run.runId
                          ? 'border-info/70 bg-info/10 shadow-md'
                          : 'border-base-300/70 bg-base-100/50 hover:border-info/40 hover:bg-base-100/80'
                      }`}
                    >
                      <div className="card-body gap-2 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-base-content">{run.repo} #{run.issue}</p>
                            <p className="text-xs text-base-content/60">{run.runId}</p>
                          </div>
                          <span className={`badge badge-sm badge-outline capitalize ${STATUS_TONE[run.status]}`}>
                            {run.status.replaceAll('_', ' ')}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs text-base-content/75 md:grid-cols-4">
                          <span>Phase: {run.phase ?? '-'}</span>
                          <span>Iter: {run.iterations}</span>
                          <span>Cost: ${formatMoney(run.costUsd)}</span>
                          <span>{formatRunTime(run)}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
            <div className="card-body p-4 sm:p-5">
              <h2 className="card-title text-lg">Operations</h2>
              {!operationsEnabled && (
                <div className="alert alert-warning mt-1 text-xs">
                  <span>
                    Attach mode: operations are disabled. Start with <code>night-orch web --standalone</code> to enable control actions.
                  </span>
                </div>
              )}

              <fieldset disabled={!operationsEnabled} className={`space-y-4 ${!operationsEnabled ? 'opacity-60' : ''}`}>
                <div className="grid grid-cols-1 gap-2">
                  <ActionButton
                    busy={activeOperation === 'poll'}
                    onClick={() => {
                      void runOperation('poll', '/api/operations/poll', {}, 'Manual poll requested')
                    }}
                    label="Trigger Poll"
                  />
                  <ActionButton
                    busy={activeOperation === 'sync'}
                    onClick={() => {
                      void runOperation('sync', '/api/operations/sync', {}, 'Sync completed')
                    }}
                    label="Run Sync"
                  />
                  <ActionButton
                    busy={activeOperation === 'cleanup'}
                    onClick={() => {
                      void runOperation('cleanup', '/api/operations/cleanup', {}, 'Cleanup completed')
                    }}
                    label="Run Cleanup"
                  />
                </div>

                <form className="rounded-box border border-base-300/70 bg-base-100/60 p-3" onSubmit={(event) => { void submitRetry(event) }}>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Retry</h3>
                  <div className="mt-2 space-y-2">
                    <label className="form-control">
                      <div className="label py-0 pb-1">
                        <span className="label-text text-xs">Repo</span>
                      </div>
                      <select
                        className="select select-bordered select-sm w-full bg-base-100/90"
                        value={retryRepo}
                        onChange={(event) => setRetryRepo(event.target.value)}
                      >
                        {repos.map((repo) => (
                          <option key={repo} value={repo}>{repo}</option>
                        ))}
                      </select>
                    </label>
                    <label className="form-control">
                      <div className="label py-0 pb-1">
                        <span className="label-text text-xs">Issue Number</span>
                      </div>
                      <input
                        className="input input-bordered input-sm w-full bg-base-100/90"
                        value={retryIssueNumber}
                        onChange={(event) => setRetryIssueNumber(event.target.value)}
                        inputMode="numeric"
                        placeholder="123"
                      />
                    </label>
                    <label className="label cursor-pointer justify-start gap-2 py-0">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-info checkbox-sm"
                        checked={retryResetPlan}
                        onChange={(event) => setRetryResetPlan(event.target.checked)}
                      />
                      <span className="label-text text-xs">Reset saved plan</span>
                    </label>
                    <label className="label cursor-pointer justify-start gap-2 py-0">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-info checkbox-sm"
                        checked={retryFresh}
                        onChange={(event) => setRetryFresh(event.target.checked)}
                      />
                      <span className="label-text text-xs">Fresh branch reset</span>
                    </label>
                    <ActionButton busy={activeOperation === 'retry'} label="Queue Retry" submit />
                  </div>
                </form>

                <form className="rounded-box border border-base-300/70 bg-base-100/60 p-3" onSubmit={(event) => { void submitRebase(event) }}>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Rebase</h3>
                  <div className="mt-2 space-y-2">
                    <label className="form-control">
                      <div className="label py-0 pb-1">
                        <span className="label-text text-xs">Repo</span>
                      </div>
                      <select
                        className="select select-bordered select-sm w-full bg-base-100/90"
                        value={rebaseRepo}
                        onChange={(event) => setRebaseRepo(event.target.value)}
                      >
                        {repos.map((repo) => (
                          <option key={repo} value={repo}>{repo}</option>
                        ))}
                      </select>
                    </label>
                    <label className="form-control">
                      <div className="label py-0 pb-1">
                        <span className="label-text text-xs">Issue Number</span>
                      </div>
                      <input
                        className="input input-bordered input-sm w-full bg-base-100/90"
                        value={rebaseIssueNumber}
                        onChange={(event) => setRebaseIssueNumber(event.target.value)}
                        inputMode="numeric"
                        placeholder="123"
                      />
                    </label>
                    <ActionButton busy={activeOperation === 'rebase'} label="Queue Rebase" submit />
                  </div>
                </form>

                <form className="rounded-box border border-base-300/70 bg-base-100/60 p-3" onSubmit={(event) => { void submitDeleteEntry(event) }}>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Delete Entry</h3>
                  <div className="mt-2 space-y-2">
                    <label className="form-control">
                      <div className="label py-0 pb-1">
                        <span className="label-text text-xs">Repo</span>
                      </div>
                      <select
                        className="select select-bordered select-sm w-full bg-base-100/90"
                        value={deleteRepo}
                        onChange={(event) => setDeleteRepo(event.target.value)}
                      >
                        {repos.map((repo) => (
                          <option key={repo} value={repo}>{repo}</option>
                        ))}
                      </select>
                    </label>
                    <label className="form-control">
                      <div className="label py-0 pb-1">
                        <span className="label-text text-xs">Issue Number</span>
                      </div>
                      <input
                        className="input input-bordered input-sm w-full bg-base-100/90"
                        value={deleteIssueNumber}
                        onChange={(event) => setDeleteIssueNumber(event.target.value)}
                        inputMode="numeric"
                        placeholder="123"
                      />
                    </label>
                    <label className="label cursor-pointer justify-start gap-2 py-0">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-warning checkbox-sm"
                        checked={deleteForce}
                        onChange={(event) => setDeleteForce(event.target.checked)}
                      />
                      <span className="label-text text-xs">Force delete if running</span>
                    </label>
                    <ActionButton busy={activeOperation === 'delete-entry'} label="Delete Local Entry" submit />
                  </div>
                </form>
              </fieldset>
            </div>
          </div>
        </section>

        <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="card-title text-lg">Run Event Stream</h2>
              {selectedRun && (
                <p className="text-xs text-base-content/70">
                  {selectedRun.repo} #{selectedRun.issue} ({selectedRun.runId})
                </p>
              )}
            </div>

            {!selectedRunId ? (
              <div className="alert mt-3 border border-base-300/60 bg-base-100/70 text-sm">
                <span>Select a run to stream live events.</span>
              </div>
            ) : runEvents.length === 0 ? (
              <div className="alert mt-3 border border-base-300/60 bg-base-100/70 text-sm">
                <span>No events yet for this run.</span>
              </div>
            ) : (
              <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                {runEvents.slice(-150).map((event) => (
                  <div key={event.id} className="rounded-box border border-base-300/70 bg-base-100/80 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/70">
                      <span>{formatTimestamp(event.timestamp)}</span>
                      <span>{event.phase} / {event.role}</span>
                    </div>
                    <p className="mt-1 text-sm font-semibold text-info">{event.type}</p>
                    <p className="mt-1 text-xs text-base-content/85">{describeEventData(event.data)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

interface MetricCardProps {
  label: string
  value: number | string
  accent: 'cyan' | 'amber' | 'emerald' | 'sky'
  subValue?: string
}

function MetricCard({ label, value, accent, subValue }: MetricCardProps): ReactElement {
  const accentClass = accent === 'amber'
    ? 'border-warning/50 bg-warning/10'
    : accent === 'emerald'
      ? 'border-success/50 bg-success/10'
      : accent === 'sky'
        ? 'border-accent/50 bg-accent/10'
        : 'border-info/50 bg-info/10'

  return (
    <article className={`stat rounded-box border px-4 py-3 shadow-panel ${accentClass}`}>
      <div className="stat-title text-[11px] uppercase tracking-wider text-base-content/70">{label}</div>
      <div className="stat-value text-2xl text-base-content">{value}</div>
      {subValue && <div className="stat-desc text-[11px] text-base-content/70">{subValue}</div>}
    </article>
  )
}

interface ActionButtonProps {
  label: string
  busy: boolean
  onClick?: () => void
  submit?: boolean
}

function ActionButton({ label, busy, onClick, submit = false }: ActionButtonProps): ReactElement {
  return (
    <button
      type={submit ? 'submit' : 'button'}
      onClick={onClick}
      className={`btn btn-info btn-sm w-full ${submit ? '' : 'btn-outline'} justify-between`}
      disabled={busy}
    >
      {busy ? 'Working...' : label}
    </button>
  )
}

function asRunEventsPayload(payload: unknown): RunEventsPayload | null {
  if (!payload || typeof payload !== 'object') return null

  const runId = (payload as { runId?: unknown }).runId
  const events = (payload as { events?: unknown }).events
  const lastEventId = (payload as { lastEventId?: unknown }).lastEventId

  if (typeof runId !== 'string') return null
  if (!Array.isArray(events)) return null
  if (typeof lastEventId !== 'number') return null

  return {
    runId,
    events: events.filter((event): event is RunEvent => {
      if (!event || typeof event !== 'object') return false
      const maybeId = (event as { id?: unknown }).id
      return typeof maybeId === 'number'
    }),
    lastEventId,
  }
}

function mergeRunEvents(existing: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const seen = new Set(existing.map((event) => event.id))
  const merged = [...existing]

  for (const event of incoming) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    merged.push(event)
  }

  merged.sort((a, b) => a.id - b.id)
  return merged
}

function extractMessage(payload: Record<string, unknown>): string | null {
  const direct = payload['message']
  if (typeof direct === 'string' && direct.trim()) {
    return direct
  }

  const reason = payload['reason']
  if (typeof reason === 'string' && reason.trim()) {
    return reason
  }

  return null
}

function formatMoney(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00'
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatRunTime(run: RunSummary): string {
  if (run.endedAt) {
    return `Ended ${formatTimestamp(run.endedAt)}`
  }
  if (run.startedAt) {
    return `Started ${formatTimestamp(run.startedAt)}`
  }
  return 'Not started'
}

function describeEventData(data: Record<string, unknown> | null): string {
  if (!data) return 'No payload'

  if (typeof data['text'] === 'string' && data['text'].trim()) {
    return truncate(data['text'], 220)
  }

  if (typeof data['toolName'] === 'string') {
    return `Tool: ${data['toolName']}`
  }

  if (typeof data['error'] === 'string') {
    return truncate(data['error'], 220)
  }

  try {
    return truncate(JSON.stringify(data), 220)
  } catch {
    return 'Unserializable event payload'
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3)}...`
}
