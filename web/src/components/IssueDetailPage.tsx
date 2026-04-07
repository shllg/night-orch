import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'

import { describeEventData, formatTimestamp, truncate } from '../lib/format.js'
import { type RunEvent, type RunSummary } from '../types/dashboard.js'

interface IssueDetailPageProps {
  run: RunSummary | null
  runId: string
  runEvents: RunEvent[]
  onBack: () => void
}

const MAX_VISIBLE_EVENTS = 400
const SCROLL_BOTTOM_THRESHOLD_PX = 20

export function IssueDetailPage({
  run,
  runId,
  runEvents,
  onBack,
}: IssueDetailPageProps): ReactElement {
  const [autoScroll, setAutoScroll] = useState(true)
  const eventsContainerRef = useRef<HTMLDivElement | null>(null)

  const visibleEvents = useMemo(
    () => runEvents.slice(-MAX_VISIBLE_EVENTS),
    [runEvents],
  )

  useEffect(() => {
    const element = eventsContainerRef.current
    if (!element || !autoScroll) return
    element.scrollTop = element.scrollHeight
  }, [autoScroll, visibleEvents.length])

  useEffect(() => {
    setAutoScroll(true)
  }, [runId])

  return (
    <section className="card min-w-0 overflow-hidden border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
      <div className="card-body p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="card-title text-lg">Issue Detail</h2>
            <p className="break-all text-xs text-base-content/70">
              {run ? `${run.repo} #${run.issue}` : `Run ${runId}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className={`btn btn-sm ${autoScroll ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setAutoScroll((current) => !current)}
            >
              Auto-scroll {autoScroll ? 'on' : 'off'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onBack}>
              Back to issues
            </button>
          </div>
        </div>

        {!run ? (
          <div className="alert mt-4 border border-base-300/60 bg-base-100/70 text-sm">
            <span>Run "{runId}" is not in the current dashboard snapshot.</span>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <section className="min-w-0 rounded-box border border-base-300/70 bg-base-100/70 px-3 py-3">
              <p className="break-words text-sm font-semibold text-base-content">
                {truncate(resolveIssueTitle(run.issueTitle), 200)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-base-content/80">
                <span className="badge badge-sm">{run.status.replaceAll('_', ' ')}</span>
                <span className="badge badge-sm">phase {truncate(run.phase?.trim() || '-', 28)}</span>
                <span className="badge badge-sm">iter {run.iterations}</span>
                <span className="badge badge-sm">${run.costUsd.toFixed(2)}</span>
                <span className="badge badge-sm">
                  {run.prNumber !== null ? `PR #${run.prNumber}` : 'no PR'}
                </span>
              </div>
              {run.lastError && (
                <p className="mt-2 whitespace-pre-wrap break-words rounded-md border border-error/30 bg-error/10 px-2 py-1 text-xs text-error">
                  {truncate(run.lastError, 2000)}
                </p>
              )}
              <p className="mt-2 text-[11px] text-base-content/65">
                started {run.startedAt ? formatTimestamp(run.startedAt) : '-'}
                {'  ·  '}
                ended {run.endedAt ? formatTimestamp(run.endedAt) : '-'}
              </p>
            </section>

            {!run.hasRun ? (
              <div className="alert border border-base-300/60 bg-base-100/70 text-sm">
                <span>This issue is tracked but has no run yet.</span>
              </div>
            ) : visibleEvents.length === 0 ? (
              <div className="alert border border-base-300/60 bg-base-100/70 text-sm">
                <span>No events yet for this run.</span>
              </div>
            ) : (
              <section className="min-w-0 rounded-box border border-base-300/70 bg-base-100/70 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-base-content">Event Stream</h3>
                  <p className="text-xs text-base-content/65">
                    Showing {visibleEvents.length} events
                    {runEvents.length > visibleEvents.length ? ` (latest ${visibleEvents.length})` : ''}
                  </p>
                </div>
                <div
                  ref={eventsContainerRef}
                  onScroll={() => {
                    const element = eventsContainerRef.current
                    if (!element) return
                    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
                    setAutoScroll(distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX)
                  }}
                  className="mt-3 max-h-[70vh] min-w-0 space-y-2 overflow-x-hidden overflow-y-auto pr-1"
                >
                  {visibleEvents.map((event) => (
                    <div key={event.id} className="min-w-0 rounded-box border border-base-300/70 bg-base-200/70 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/70">
                        <span>{formatTimestamp(event.timestamp)}</span>
                        <span className="break-all">{event.phase} / {event.role}</span>
                      </div>
                      <p className="mt-1 break-words text-sm font-semibold text-info">{event.type}</p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-base-content/85">
                        {describeEventData(event.data)}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function resolveIssueTitle(issueTitle: string | null): string {
  const title = issueTitle?.trim()
  return title && title.length > 0 ? title : '(title unavailable)'
}
