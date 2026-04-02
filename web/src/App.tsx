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
  queued: 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40',
  running: 'bg-amber-500/20 text-amber-100 border-amber-300/50',
  blocked: 'bg-orange-600/25 text-orange-100 border-orange-400/40',
  review_ready: 'bg-emerald-500/20 text-emerald-100 border-emerald-300/40',
  error: 'bg-rose-600/25 text-rose-100 border-rose-400/40',
  completed: 'bg-slate-600/30 text-slate-200 border-slate-400/30',
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
    <main className="min-h-screen bg-orch-gradient px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <header className="rounded-2xl border border-white/15 bg-slate-950/55 p-4 shadow-xl backdrop-blur sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-300">night-orch</p>
              <h1 className="text-2xl font-semibold sm:text-3xl">Web Control Center</h1>
              <p className="mt-1 text-sm text-slate-300">
                Poll interval {snapshot?.config.pollIntervalSeconds ?? '-'}s
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`inline-flex items-center rounded-full border px-3 py-1 font-medium ${socketConnected ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-100' : 'border-rose-400/40 bg-rose-500/15 text-rose-100'}`}>
                {socketConnected ? 'WebSocket connected' : 'WebSocket reconnecting'}
              </span>
              <span className="rounded-full border border-slate-600/50 bg-slate-800/65 px-3 py-1 text-slate-200">
                Last refresh {snapshot ? formatTimestamp(snapshot.generatedAt) : '--'}
              </span>
            </div>
          </div>

          {(errorMessage || feedbackMessage) && (
            <div className="mt-3 flex flex-col gap-2 text-sm">
              {errorMessage && (
                <div className="rounded-xl border border-rose-400/45 bg-rose-500/15 px-3 py-2 text-rose-100">
                  {errorMessage}
                </div>
              )}
              {feedbackMessage && (
                <div className="rounded-xl border border-cyan-400/45 bg-cyan-500/15 px-3 py-2 text-cyan-100">
                  {feedbackMessage}
                </div>
              )}
            </div>
          )}
        </header>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

        <section className="grid gap-5 lg:grid-cols-[1.65fr_1fr]">
          <div className="rounded-2xl border border-white/15 bg-slate-950/55 p-4 shadow-xl backdrop-blur sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold">Runs</h2>
              <label className="text-sm text-slate-200">
                <span className="mr-2">Repo</span>
                <select
                  className="rounded-lg border border-slate-600 bg-slate-900/80 px-2 py-1 text-sm"
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
              <p className="mt-4 text-sm text-slate-300">Loading dashboard...</p>
            ) : filteredRuns.length === 0 ? (
              <p className="mt-4 text-sm text-slate-300">No runs for the current filter.</p>
            ) : (
              <div className="mt-4 grid gap-3">
                {filteredRuns.map((run) => (
                  <button
                    key={run.runId}
                    type="button"
                    onClick={() => setSelectedRunId(run.runId)}
                    className={`w-full rounded-xl border p-3 text-left transition ${selectedRunId === run.runId ? 'border-cyan-300 bg-cyan-500/10' : 'border-slate-700/60 bg-slate-900/65 hover:border-cyan-400/50 hover:bg-slate-800/65'}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-slate-100">{run.repo} #{run.issue}</p>
                        <p className="text-xs text-slate-300">{run.runId}</p>
                      </div>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${STATUS_TONE[run.status]}`}>
                        {run.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-slate-300 sm:grid-cols-4">
                      <span>Phase: {run.phase ?? '-'}</span>
                      <span>Iter: {run.iterations}</span>
                      <span>Cost: ${formatMoney(run.costUsd)}</span>
                      <span>{formatRunTime(run)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

            <div className="rounded-2xl border border-white/15 bg-slate-950/55 p-4 shadow-xl backdrop-blur sm:p-5">
              <h2 className="text-lg font-semibold">Operations</h2>
              {!operationsEnabled && (
                <p className="mt-2 rounded-lg border border-slate-600/70 bg-slate-900/70 px-3 py-2 text-xs text-slate-300">
                  Attach mode: operations are disabled. Start with <code className="text-slate-100">night-orch web --standalone</code> to enable control actions.
                </p>
              )}

              <fieldset
                disabled={!operationsEnabled}
                className={`mt-3 ${!operationsEnabled ? 'opacity-60' : ''}`}
              >
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

                <form className="mt-5 space-y-2" onSubmit={(event) => { void submitRetry(event) }}>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">Retry</h3>
                  <label className="block text-xs text-slate-300">
                    Repo
                    <select
                      className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/80 px-2 py-1"
                      value={retryRepo}
                      onChange={(event) => setRetryRepo(event.target.value)}
                    >
                      {repos.map((repo) => (
                        <option key={repo} value={repo}>{repo}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-slate-300">
                    Issue Number
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/80 px-2 py-1"
                      value={retryIssueNumber}
                      onChange={(event) => setRetryIssueNumber(event.target.value)}
                      inputMode="numeric"
                      placeholder="123"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={retryResetPlan} onChange={(event) => setRetryResetPlan(event.target.checked)} />
                    Reset saved plan
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={retryFresh} onChange={(event) => setRetryFresh(event.target.checked)} />
                    Fresh branch reset
                  </label>
                  <ActionButton busy={activeOperation === 'retry'} label="Queue Retry" submit />
                </form>

                <form className="mt-5 space-y-2" onSubmit={(event) => { void submitRebase(event) }}>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">Rebase</h3>
                  <label className="block text-xs text-slate-300">
                    Repo
                    <select
                      className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/80 px-2 py-1"
                      value={rebaseRepo}
                      onChange={(event) => setRebaseRepo(event.target.value)}
                    >
                      {repos.map((repo) => (
                        <option key={repo} value={repo}>{repo}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-slate-300">
                    Issue Number
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/80 px-2 py-1"
                      value={rebaseIssueNumber}
                      onChange={(event) => setRebaseIssueNumber(event.target.value)}
                      inputMode="numeric"
                      placeholder="123"
                    />
                  </label>
                  <ActionButton busy={activeOperation === 'rebase'} label="Queue Rebase" submit />
                </form>

                <form className="mt-5 space-y-2" onSubmit={(event) => { void submitDeleteEntry(event) }}>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">Delete Entry</h3>
                  <label className="block text-xs text-slate-300">
                    Repo
                    <select
                      className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/80 px-2 py-1"
                      value={deleteRepo}
                      onChange={(event) => setDeleteRepo(event.target.value)}
                    >
                      {repos.map((repo) => (
                        <option key={repo} value={repo}>{repo}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-slate-300">
                    Issue Number
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/80 px-2 py-1"
                      value={deleteIssueNumber}
                      onChange={(event) => setDeleteIssueNumber(event.target.value)}
                      inputMode="numeric"
                      placeholder="123"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={deleteForce} onChange={(event) => setDeleteForce(event.target.checked)} />
                    Force delete if running
                  </label>
                  <ActionButton busy={activeOperation === 'delete-entry'} label="Delete Local Entry" submit />
                </form>
              </fieldset>
            </div>
          </section>

        <section className="rounded-2xl border border-white/15 bg-slate-950/55 p-4 shadow-xl backdrop-blur sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Run Event Stream</h2>
            {selectedRun && (
              <p className="text-xs text-slate-300">
                {selectedRun.repo} #{selectedRun.issue} ({selectedRun.runId})
              </p>
            )}
          </div>

          {!selectedRunId ? (
            <p className="mt-3 text-sm text-slate-300">Select a run to stream live events.</p>
          ) : runEvents.length === 0 ? (
            <p className="mt-3 text-sm text-slate-300">No events yet for this run.</p>
          ) : (
            <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
              {runEvents.slice(-150).map((event) => (
                <div key={event.id} className="rounded-lg border border-slate-700/70 bg-slate-900/70 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                    <span>{formatTimestamp(event.timestamp)}</span>
                    <span>{event.phase} / {event.role}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-cyan-100">{event.type}</p>
                  <p className="mt-1 text-xs text-slate-200">{describeEventData(event.data)}</p>
                </div>
              ))}
            </div>
          )}
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
    ? 'border-amber-400/45 bg-amber-500/15 text-amber-50'
    : accent === 'emerald'
      ? 'border-emerald-400/45 bg-emerald-500/15 text-emerald-50'
      : accent === 'sky'
        ? 'border-sky-400/45 bg-sky-500/15 text-sky-50'
        : 'border-cyan-400/45 bg-cyan-500/15 text-cyan-50'

  return (
    <article className={`rounded-xl border p-3 shadow-lg ${accentClass}`}>
      <p className="text-[11px] uppercase tracking-wider text-white/75">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {subValue && <p className="mt-1 text-[11px] text-white/75">{subValue}</p>}
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
      className="rounded-lg border border-cyan-300/45 bg-cyan-500/15 px-3 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-400/25 disabled:cursor-not-allowed disabled:opacity-50"
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
