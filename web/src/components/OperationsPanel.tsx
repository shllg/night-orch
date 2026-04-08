import { type FormEvent, type ReactElement } from 'react'

import { type UpdateStatus } from '../types/dashboard.js'
import { ActionButton } from './ActionButton.js'

interface LabelsInitFormState {
  repo: string
}

interface OperationsPanelProps {
  operationsEnabled: boolean
  activeOperation: string | null
  updateStatus: UpdateStatus | null
  installMethod?: 'git' | 'npm' | 'unknown'
  repos: string[]
  labelsInitForm: LabelsInitFormState
  onLabelsInitFormChange: (patch: Partial<LabelsInitFormState>) => void
  onPoll: () => void
  onSync: () => void
  onCleanup: () => void
  onLabelsInitSubmit: (event: FormEvent<HTMLFormElement>) => void
  onUpdate: () => void
}

export function OperationsPanel({
  operationsEnabled,
  activeOperation,
  updateStatus,
  installMethod = 'unknown',
  repos,
  labelsInitForm,
  onLabelsInitFormChange,
  onPoll,
  onSync,
  onCleanup,
  onLabelsInitSubmit,
  onUpdate,
}: OperationsPanelProps): ReactElement {
  const updateRunning =
    activeOperation === 'update' ||
    (updateStatus != null && updateStatus.state !== 'idle' && updateStatus.state !== 'failed')

  const updateButtonLabel = ((): string => {
    if (updateStatus && updateStatus.state !== 'idle' && updateStatus.state !== 'failed') {
      return `Updating (${updateStatus.state})...`
    }
    return installMethod === 'npm' ? 'Update Package' : 'Pull & Restart'
  })()

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

          <form className="rounded-box border border-base-300/70 bg-base-100/60 p-3" onSubmit={onLabelsInitSubmit}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Labels Init</h3>
            <div className="mt-2 space-y-2">
              <label className="form-control">
                <div className="label py-0 pb-1">
                  <span className="label-text text-xs">Repo</span>
                </div>
                <select
                  className="select select-bordered select-sm w-full bg-base-100/90"
                  value={labelsInitForm.repo}
                  onChange={(event) => onLabelsInitFormChange({ repo: event.target.value })}
                >
                  {repos.map((repo) => (
                    <option key={repo} value={repo}>{repo}</option>
                  ))}
                </select>
              </label>
              <ActionButton busy={activeOperation === 'labels-init'} label="Bootstrap Labels" submit />
            </div>
          </form>
        </fieldset>

        <div className="mt-4 rounded-box border border-base-300/70 bg-base-100/60 p-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-info">Deploy</h3>
          <div className="mt-2 space-y-2">
            <ActionButton
              busy={updateRunning}
              onClick={onUpdate}
              label={updateButtonLabel}
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
