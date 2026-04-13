import { type ReactElement } from 'react'
import { BadgeWeb } from '../../../src/components/badge/badge.web.js'
import { ButtonWeb } from '../../../src/components/button/button.web.js'

import { formatMoney, formatRunTime, truncate } from '../lib/format.js'
import {
  badgeToneForCostUsd,
  badgeToneForIterationCount,
  badgeToneForPhase,
  badgeToneForPrNumber,
} from '../lib/run-tone.js'
import { type RunListView, type RunStatus, type RunSummary } from '../types/dashboard.js'

interface RunsPanelProps {
  isLoading: boolean
  isLoadingMore: boolean
  repos: string[]
  selectedRepo: string
  onSelectedRepoChange: (repo: string) => void
  runsView: RunListView
  onRunsViewChange: (view: RunListView) => void
  filteredRuns: RunSummary[]
  canLoadMore: boolean
  onLoadMore: () => void
  selectedRunId: string
  onOpenRun: (runId: string) => void
  statusTone: Record<RunStatus, string>
}

export function RunsPanel({
  isLoading,
  isLoadingMore,
  repos,
  selectedRepo,
  onSelectedRepoChange,
  runsView,
  onRunsViewChange,
  filteredRuns,
  canLoadMore,
  onLoadMore,
  selectedRunId,
  onOpenRun,
  statusTone,
}: RunsPanelProps): ReactElement {
  return (
    <div className="card min-w-0 overflow-hidden border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
      <div className="card-body p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="card-title text-lg">Runs</h2>
            <p className="text-xs text-base-content/70">Live runs plus archived history from SQLite.</p>
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
              onChange={(event) => onSelectedRepoChange(event.target.value)}
            >
              <option value="all">All repos</option>
              {repos.map((repo) => (
                <option key={repo} value={repo}>{repo}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {RUN_VIEW_FILTERS.map((view) => (
            <ButtonWeb
              key={view.value}
              type="button"
              onClick={() => onRunsViewChange(view.value)}
              size="xs"
              tone={runsView === view.value ? 'primary' : 'ghost'}
            >
              {view.label}
            </ButtonWeb>
          ))}
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
          <>
            <div className="mt-4 grid max-h-[540px] min-w-0 gap-3 overflow-x-hidden overflow-y-auto pr-1">
              {filteredRuns.map((run) => {
                const isRunning = run.status === 'running'
                return (
                  <button
                    key={run.runId}
                    type="button"
                    onClick={() => onOpenRun(run.runId)}
                    className={`card w-full min-w-0 overflow-hidden border text-left transition-all ${
                      selectedRunId === run.runId
                        ? 'border-primary/65 bg-primary/10 shadow-md'
                        : 'border-base-300/70 bg-base-100/50 hover:border-primary/40 hover:bg-base-100/80'
                    } ${isRunning ? 'orch-running-card' : ''}`}
                  >
                    <div className="card-body min-w-0 gap-2.5 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="break-all text-xs font-medium uppercase tracking-wide text-base-content/70">
                            {run.repo} #{run.issue}
                          </p>
                          <p className="mt-0.5 break-words text-sm font-semibold text-base-content">
                            {truncate(resolveIssueTitle(run.issueTitle), 110)}
                          </p>
                          <p className="mt-0.5 break-all text-xs text-base-content/55">
                            {run.hasRun ? run.runId : 'Tracked issue (no run yet)'}
                          </p>
                        </div>
                        <BadgeWeb
                          size="sm"
                          capitalize
                          className={`${statusTone[run.status]} ${isRunning ? 'orch-working-pulse' : ''}`}
                        >
                          {run.status.replaceAll('_', ' ')}
                        </BadgeWeb>
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                        <BadgeWeb size="xs" className={badgeToneForPhase(run.phase)}>
                          phase {truncate(resolvePhaseLabel(run.phase), 18)}
                        </BadgeWeb>
                        <BadgeWeb size="xs" className={badgeToneForIterationCount(run.iterations)}>
                          iter {run.iterations}
                        </BadgeWeb>
                        <BadgeWeb size="xs" className={badgeToneForCostUsd(run.costUsd)}>
                          ${formatMoney(run.costUsd)}
                        </BadgeWeb>
                        <BadgeWeb size="xs" className={badgeToneForPrNumber(run.prNumber)}>
                          {run.prNumber !== null ? `PR #${run.prNumber}` : 'no PR'}
                        </BadgeWeb>
                        <span className="max-w-full text-[11px] text-base-content/65 sm:ml-auto">
                          {formatRunTime(run)}
                        </span>
                      </div>
                      {run.lastError && (
                        <p className="whitespace-pre-wrap break-words rounded-md border border-error/30 bg-error/10 px-2 py-1 text-xs text-error">
                          {truncate(run.lastError, 500)}
                        </p>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            {canLoadMore && (
              <div className="mt-4 flex justify-center">
                <ButtonWeb
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onLoadMore}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? 'Loading...' : 'Load more'}
                </ButtonWeb>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const RUN_VIEW_FILTERS: Array<{ value: RunListView; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'all', label: 'All' },
]

function resolveIssueTitle(issueTitle: string | null): string {
  const title = issueTitle?.trim()
  return title && title.length > 0 ? title : '(title unavailable)'
}

function resolvePhaseLabel(phase: string | null): string {
  const value = phase?.trim()
  return value && value.length > 0 ? value : '-'
}
