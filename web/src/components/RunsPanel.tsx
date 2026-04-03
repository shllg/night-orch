import { type ReactElement } from 'react'

import { formatMoney, formatRunTime } from '../lib/format.js'
import { type RunStatus, type RunSummary } from '../types/dashboard.js'

interface RunsPanelProps {
  isLoading: boolean
  repos: string[]
  selectedRepo: string
  onSelectedRepoChange: (repo: string) => void
  filteredRuns: RunSummary[]
  selectedRunId: string
  onSelectedRunChange: (runId: string) => void
  statusTone: Record<RunStatus, string>
}

export function RunsPanel({
  isLoading,
  repos,
  selectedRepo,
  onSelectedRepoChange,
  filteredRuns,
  selectedRunId,
  onSelectedRunChange,
  statusTone,
}: RunsPanelProps): ReactElement {
  return (
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
              onChange={(event) => onSelectedRepoChange(event.target.value)}
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
                onClick={() => onSelectedRunChange(run.runId)}
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
                      <p className="text-xs text-base-content/60">
                        {run.hasRun ? run.runId : 'Tracked issue (no run yet)'}
                      </p>
                    </div>
                    <span className={`badge badge-sm badge-outline capitalize ${statusTone[run.status]}`}>
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
  )
}
