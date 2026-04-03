import { type FormEvent, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DashboardHeader } from './components/DashboardHeader.js'
import { DashboardMetrics } from './components/DashboardMetrics.js'
import { OperationsPanel } from './components/OperationsPanel.js'
import { RunEventStream } from './components/RunEventStream.js'
import { RunsPanel } from './components/RunsPanel.js'
import { extractMessage } from './lib/format.js'
import { asRunEventsPayload, mergeRunEvents } from './lib/run-events.js'
import {
  type DashboardSnapshot,
  type RunEvent,
  type RunStatus,
  type SessionResponse,
  type UpdateStatus,
  type WsEnvelope,
} from './types/dashboard.js'

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

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const selectedStreamRunIdRef = useRef('')
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
  const selectedStreamRunId = selectedRun?.hasRun ? selectedRun.runId : ''

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

  useEffect(() => {
    if (!updateStatus || updateStatus.state === 'idle') return

    const interval = window.setInterval(async () => {
      try {
        const res = await fetch('/api/update-status')
        if (res.ok) {
          const status = await res.json() as UpdateStatus
          setUpdateStatus(status)
          if (status.state === 'idle' || status.state === 'failed') {
            window.clearInterval(interval)
            if (status.state === 'failed') {
              setErrorMessage(`Update failed: ${status.error ?? 'unknown error'}`)
            } else {
              setFeedbackMessage('Update complete - services restarted')
            }
          }
        }
      } catch {
        // Ignore fetch errors during update.
      }
    }, 2000)

    return () => {
      window.clearInterval(interval)
    }
  }, [updateStatus?.state])

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
        <DashboardHeader
          pollIntervalSeconds={snapshot?.config.pollIntervalSeconds ?? null}
          generatedAt={snapshot?.generatedAt ?? null}
          socketConnected={socketConnected}
        />

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
            statusTone={STATUS_TONE}
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
            deleteEntryForm={{
              repo: deleteRepo,
              issueNumber: deleteIssueNumber,
              force: deleteForce,
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
            onDeleteEntryFormChange={(patch) => {
              if (patch.repo !== undefined) setDeleteRepo(patch.repo)
              if (patch.issueNumber !== undefined) setDeleteIssueNumber(patch.issueNumber)
              if (patch.force !== undefined) setDeleteForce(patch.force)
            }}
            onPoll={() => {
              void runOperation('poll', '/api/operations/poll', {}, 'Manual poll requested')
            }}
            onSync={() => {
              void runOperation('sync', '/api/operations/sync', {}, 'Sync completed')
            }}
            onCleanup={() => {
              void runOperation('cleanup', '/api/operations/cleanup', {}, 'Cleanup completed')
            }}
            onRetrySubmit={(event) => {
              void submitRetry(event)
            }}
            onRebaseSubmit={(event) => {
              void submitRebase(event)
            }}
            onDeleteEntrySubmit={(event) => {
              void submitDeleteEntry(event)
            }}
            onUpdate={() => {
              setUpdateStatus({ state: 'draining' })
              void runOperation('update', '/api/operations/update', {}, 'Update initiated - pulling and rebuilding...')
            }}
          />
        </section>

        <RunEventStream selectedRunId={selectedRunId} selectedRun={selectedRun} runEvents={runEvents} />
      </div>
    </main>
  )
}
