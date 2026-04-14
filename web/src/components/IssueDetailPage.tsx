import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { AlertWeb } from '../../../src/components/alert/alert.web.js'
import { BadgeWeb } from '../../../src/components/badge/badge.web.js'
import { ButtonWeb } from '../../../src/components/button/button.web.js'
import { SelectWeb } from '../../../src/components/select/select.web.js'

import { describeRunEvent, formatTimestamp, formatTokenCount, truncate } from '../lib/format.js'
import { STATUS_BADGE_TONE } from '../lib/run-tone.js'
import { type RunEvent, type RunSummary } from '../types/dashboard.js'
import { ActionButton } from './ActionButton.js'

type UpdateStrategy = 'merge' | 'rebase'

interface IssueDetailPageProps {
  run: RunSummary | null
  runId: string
  runEvents: RunEvent[]
  operationsEnabled: boolean
  activeOperation: string | null
  onRetry: (run: RunSummary, strategy: UpdateStrategy | null) => void
  onRebase: (run: RunSummary, strategy: UpdateStrategy | null) => void
  onContinue: (run: RunSummary, strategy: UpdateStrategy | null) => void
  onDeleteEntry: (run: RunSummary, force: boolean) => void
  onResetCost: (run: RunSummary) => void
  onBack: () => void
}

const MAX_VISIBLE_EVENTS = 400
const SCROLL_BOTTOM_THRESHOLD_PX = 20

export function IssueDetailPage({
  run,
  runId,
  runEvents,
  operationsEnabled,
  activeOperation,
  onRetry,
  onRebase,
  onContinue,
  onDeleteEntry,
  onResetCost,
  onBack,
}: IssueDetailPageProps): ReactElement {
  const [autoScroll, setAutoScroll] = useState(true)
  const [forceDelete, setForceDelete] = useState(false)
  const [actionStrategy, setActionStrategy] = useState<'default' | UpdateStrategy>('default')
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
    setForceDelete(false)
    setActionStrategy('default')
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
            <ButtonWeb
              type="button"
              tone={autoScroll ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setAutoScroll((current) => !current)}
            >
              Auto-scroll {autoScroll ? 'on' : 'off'}
            </ButtonWeb>
            <ButtonWeb type="button" tone="ghost" size="sm" onClick={onBack}>
              Back to issues
            </ButtonWeb>
          </div>
        </div>

        {!run ? (
          <AlertWeb className="mt-4 text-sm" role="status">
            Run &quot;{runId}&quot; is not in the current dashboard snapshot.
          </AlertWeb>
        ) : (
          <div className="mt-4 space-y-4">
            <section className="min-w-0 rounded-box border border-base-300/70 bg-base-100/70 px-3 py-3">
              <p className="break-words text-sm font-semibold text-base-content">
                {truncate(resolveIssueTitle(run.issueTitle), 200)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-base-content/80">
                <BadgeWeb size="sm" className={STATUS_BADGE_TONE[run.status]}>
                  {run.status.replaceAll('_', ' ')}
                </BadgeWeb>
                <BadgeWeb size="sm">phase {truncate(run.phase?.trim() || '-', 28)}</BadgeWeb>
                <BadgeWeb size="sm">iter {run.iterations}</BadgeWeb>
                <BadgeWeb size="sm">${run.costUsd.toFixed(2)}</BadgeWeb>
                <span
                  title={`prompt ${run.promptTokens.toLocaleString()} · completion ${run.completionTokens.toLocaleString()} · cache-read ${run.cacheReadTokens.toLocaleString()}`}
                >
                  <BadgeWeb size="sm">
                    {formatTokenCount(run.promptTokens + run.completionTokens)} tok
                  </BadgeWeb>
                </span>
                {run.cacheReadTokens > 0 && (
                  <span title={`Cache-read tokens: ${run.cacheReadTokens.toLocaleString()}`}>
                    <BadgeWeb
                      size="sm"
                      tone="ghost"
                    >
                      {formatTokenCount(run.cacheReadTokens)} cache
                    </BadgeWeb>
                  </span>
                )}
                <BadgeWeb size="sm">
                  {run.prNumber !== null ? `PR #${run.prNumber}` : 'no PR'}
                </BadgeWeb>
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

            <section className="min-w-0 rounded-box border border-base-300/70 bg-base-100/70 px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-base-content">Issue Actions</h3>
                <p className="text-xs text-base-content/65">Each action requires confirmation.</p>
              </div>
              {!operationsEnabled && (
                <AlertWeb tone="warning" className="mt-3 text-xs">
                  Operations are disabled by server policy for this web instance.
                </AlertWeb>
              )}
              <fieldset
                disabled={!operationsEnabled}
                className={`mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 ${!operationsEnabled ? 'opacity-60' : ''}`}
              >
                <label className="form-control sm:col-span-2">
                  <div className="label py-0 pb-1">
                    <span className="label-text text-xs uppercase tracking-wide text-base-content/70">
                      Update Strategy
                    </span>
                  </div>
                  <SelectWeb
                    size="sm"
                    fullWidth
                    className="bg-base-100/80"
                    value={actionStrategy}
                    onSelect={(value) => { setActionStrategy(value as 'default' | UpdateStrategy) }}
                    options={[
                      { value: 'default', label: 'Repo default' },
                      { value: 'merge', label: 'Merge' },
                      { value: 'rebase', label: 'Rebase' },
                    ]}
                  />
                </label>
                <ActionButton
                  busy={activeOperation === 'retry'}
                  onClick={() => onRetry(run, actionStrategy === 'default' ? null : actionStrategy)}
                  label="Queue Retry"
                />
                <ActionButton
                  busy={activeOperation === 'rebase'}
                  onClick={() => onRebase(run, actionStrategy === 'default' ? null : actionStrategy)}
                  label="Queue Rebase"
                />
                <ActionButton
                  busy={activeOperation === 'continue'}
                  onClick={() => onContinue(run, actionStrategy === 'default' ? null : actionStrategy)}
                  label="Queue Continue Pass"
                />
                <ActionButton
                  busy={activeOperation === 'cost-reset'}
                  onClick={() => onResetCost(run)}
                  label="Reset Cost"
                />
                <label className="label cursor-pointer justify-start gap-2 py-0 sm:col-span-2">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-warning checkbox-sm"
                    checked={forceDelete}
                    onChange={(event) => setForceDelete(event.target.checked)}
                  />
                  <span className="label-text text-xs">Force delete (for active/shared issue state)</span>
                </label>
                <ActionButton
                  busy={activeOperation === 'delete-entry'}
                  onClick={() => onDeleteEntry(run, forceDelete)}
                  label={forceDelete ? 'Force Delete Local Entry' : 'Delete Local Entry'}
                />
              </fieldset>
            </section>

            {!run.hasRun ? (
              <AlertWeb className="text-sm" role="status">
                This issue is tracked but has no run yet.
              </AlertWeb>
            ) : visibleEvents.length === 0 ? (
              <AlertWeb className="text-sm" role="status">
                No events yet for this issue.
              </AlertWeb>
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
                  className="mt-3 max-h-[70vh] min-w-0 overflow-x-hidden overflow-y-auto rounded-box border border-base-300/60 bg-base-200/50 p-3 pr-1 font-mono text-xs"
                >
                  {visibleEvents.map((event) => (
                    <div
                      key={event.id}
                      className={`grid min-w-0 grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1 border-b py-1 last:border-b-0 ${
                        event.source === 'user'
                          ? 'rounded-md border-l-2 border-l-accent border-b-base-300/30 bg-accent/5 px-2'
                          : 'border-b-base-300/30'
                      }`}
                    >
                      <span className="text-base-content/55">{formatTimestamp(event.timestamp)}</span>
                      <span
                        className={`break-all ${
                          event.source === 'system'
                            ? 'text-secondary'
                            : event.source === 'user'
                              ? 'text-accent'
                              : 'text-info'
                        }`}
                      >
                        {event.source === 'system' ? 'system' : event.source === 'user' ? `user:${event.role ?? 'manual'}` : event.role ?? 'agent'}
                      </span>
                      <span className="whitespace-pre-wrap break-words text-base-content/85">
                        {describeRunEvent(event)}
                      </span>
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
