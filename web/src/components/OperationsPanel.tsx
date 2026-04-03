import { type FormEvent, type ReactElement } from 'react'

import { type UpdateStatus } from '../types/dashboard.js'
import { ActionButton } from './ActionButton.js'

interface RetryFormState {
  repo: string
  issueNumber: string
  resetPlan: boolean
  fresh: boolean
}

interface RebaseFormState {
  repo: string
  issueNumber: string
}

interface ContinueFormState {
  repo: string
  issueNumber: string
}

interface DeleteEntryFormState {
  repo: string
  issueNumber: string
  force: boolean
}

interface OperationsPanelProps {
  operationsEnabled: boolean
  activeOperation: string | null
  updateStatus: UpdateStatus | null
  repos: string[]
  retryForm: RetryFormState
  rebaseForm: RebaseFormState
  continueForm: ContinueFormState
  deleteEntryForm: DeleteEntryFormState
  onRetryFormChange: (patch: Partial<RetryFormState>) => void
  onRebaseFormChange: (patch: Partial<RebaseFormState>) => void
  onContinueFormChange: (patch: Partial<ContinueFormState>) => void
  onDeleteEntryFormChange: (patch: Partial<DeleteEntryFormState>) => void
  onPoll: () => void
  onSync: () => void
  onCleanup: () => void
  onRetrySubmit: (event: FormEvent<HTMLFormElement>) => void
  onRebaseSubmit: (event: FormEvent<HTMLFormElement>) => void
  onContinueSubmit: (event: FormEvent<HTMLFormElement>) => void
  onDeleteEntrySubmit: (event: FormEvent<HTMLFormElement>) => void
  onUpdate: () => void
}

export function OperationsPanel({
  operationsEnabled,
  activeOperation,
  updateStatus,
  repos,
  retryForm,
  rebaseForm,
  continueForm,
  deleteEntryForm,
  onRetryFormChange,
  onRebaseFormChange,
  onContinueFormChange,
  onDeleteEntryFormChange,
  onPoll,
  onSync,
  onCleanup,
  onRetrySubmit,
  onRebaseSubmit,
  onContinueSubmit,
  onDeleteEntrySubmit,
  onUpdate,
}: OperationsPanelProps): ReactElement {
  const updateRunning =
    activeOperation === 'update' ||
    (updateStatus != null && updateStatus.state !== 'idle' && updateStatus.state !== 'failed')

  return (
    <div className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
      <div className="card-body p-4 sm:p-5">
        <h2 className="card-title text-lg">Operations</h2>
        {!operationsEnabled && (
          <div className="alert alert-warning mt-1 text-xs">
            <span>
              Operations are disabled by server policy for this web instance.
            </span>
          </div>
        )}

        <fieldset disabled={!operationsEnabled} className={`space-y-4 ${!operationsEnabled ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-1 gap-2">
            <ActionButton busy={activeOperation === 'poll'} onClick={onPoll} label="Trigger Poll" />
            <ActionButton busy={activeOperation === 'sync'} onClick={onSync} label="Run Sync" />
            <ActionButton busy={activeOperation === 'cleanup'} onClick={onCleanup} label="Run Cleanup" />
          </div>

          <form className="rounded-box border border-base-300/70 bg-base-100/60 p-3" onSubmit={onRetrySubmit}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Retry</h3>
            <div className="mt-2 space-y-2">
              <label className="form-control">
                <div className="label py-0 pb-1">
                  <span className="label-text text-xs">Repo</span>
                </div>
                <select
                  className="select select-bordered select-sm w-full bg-base-100/90"
                  value={retryForm.repo}
                  onChange={(event) => onRetryFormChange({ repo: event.target.value })}
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
                  value={retryForm.issueNumber}
                  onChange={(event) => onRetryFormChange({ issueNumber: event.target.value })}
                  inputMode="numeric"
                  placeholder="123"
                />
              </label>
              <label className="label cursor-pointer justify-start gap-2 py-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-info checkbox-sm"
                  checked={retryForm.resetPlan}
                  onChange={(event) => onRetryFormChange({ resetPlan: event.target.checked })}
                />
                <span className="label-text text-xs">Reset saved plan</span>
              </label>
              <label className="label cursor-pointer justify-start gap-2 py-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-info checkbox-sm"
                  checked={retryForm.fresh}
                  onChange={(event) => onRetryFormChange({ fresh: event.target.checked })}
                />
                <span className="label-text text-xs">Fresh branch reset</span>
              </label>
              <ActionButton busy={activeOperation === 'retry'} label="Queue Retry" submit />
            </div>
          </form>

          <form className="rounded-box border border-base-300/70 bg-base-100/60 p-3" onSubmit={onRebaseSubmit}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Rebase</h3>
            <div className="mt-2 space-y-2">
              <label className="form-control">
                <div className="label py-0 pb-1">
                  <span className="label-text text-xs">Repo</span>
                </div>
                <select
                  className="select select-bordered select-sm w-full bg-base-100/90"
                  value={rebaseForm.repo}
                  onChange={(event) => onRebaseFormChange({ repo: event.target.value })}
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
                  value={rebaseForm.issueNumber}
                  onChange={(event) => onRebaseFormChange({ issueNumber: event.target.value })}
                  inputMode="numeric"
                  placeholder="123"
                />
              </label>
              <ActionButton busy={activeOperation === 'rebase'} label="Queue Rebase" submit />
            </div>
          </form>

          <form className="rounded-box border border-base-300/70 bg-base-100/60 p-3" onSubmit={onContinueSubmit}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Continue</h3>
            <div className="mt-2 space-y-2">
              <label className="form-control">
                <div className="label py-0 pb-1">
                  <span className="label-text text-xs">Repo</span>
                </div>
                <select
                  className="select select-bordered select-sm w-full bg-base-100/90"
                  value={continueForm.repo}
                  onChange={(event) => onContinueFormChange({ repo: event.target.value })}
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
                  value={continueForm.issueNumber}
                  onChange={(event) => onContinueFormChange({ issueNumber: event.target.value })}
                  inputMode="numeric"
                  placeholder="123"
                />
              </label>
              <ActionButton busy={activeOperation === 'continue'} label="Queue Continue Pass" submit />
            </div>
          </form>

          <form className="rounded-box border border-base-300/70 bg-base-100/60 p-3" onSubmit={onDeleteEntrySubmit}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Delete Entry</h3>
            <div className="mt-2 space-y-2">
              <label className="form-control">
                <div className="label py-0 pb-1">
                  <span className="label-text text-xs">Repo</span>
                </div>
                <select
                  className="select select-bordered select-sm w-full bg-base-100/90"
                  value={deleteEntryForm.repo}
                  onChange={(event) => onDeleteEntryFormChange({ repo: event.target.value })}
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
                  value={deleteEntryForm.issueNumber}
                  onChange={(event) => onDeleteEntryFormChange({ issueNumber: event.target.value })}
                  inputMode="numeric"
                  placeholder="123"
                />
              </label>
              <label className="label cursor-pointer justify-start gap-2 py-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-warning checkbox-sm"
                  checked={deleteEntryForm.force}
                  onChange={(event) => onDeleteEntryFormChange({ force: event.target.checked })}
                />
                <span className="label-text text-xs">Force delete if running</span>
              </label>
              <ActionButton busy={activeOperation === 'delete-entry'} label="Delete Local Entry" submit />
            </div>
          </form>
        </fieldset>

        <div className="mt-4 rounded-box border border-base-300/70 bg-base-100/60 p-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Deploy</h3>
          <div className="mt-2 space-y-2">
            <ActionButton
              busy={updateRunning}
              onClick={onUpdate}
              label={
                updateStatus && updateStatus.state !== 'idle' && updateStatus.state !== 'failed'
                  ? `Updating (${updateStatus.state})...`
                  : 'Pull & Restart'
              }
            />
            {updateStatus && updateStatus.state === 'failed' && (
              <div className="text-xs text-error">{updateStatus.error}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
