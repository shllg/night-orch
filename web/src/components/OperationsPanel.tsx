import { type ReactElement } from 'react'
import { AlertWeb } from '../../../src/components/alert/alert.web.js'

import { type UpdateStatus } from '../types/dashboard.js'
import { ActionButton } from './ActionButton.js'

interface OperationsPanelProps {
  operationsEnabled: boolean
  activeOperation: string | null
  updateStatus: UpdateStatus | null
  installMethod?: 'git' | 'npm' | 'unknown'
  onUpdate: () => void
}

export function OperationsPanel({
  operationsEnabled,
  activeOperation,
  updateStatus,
  installMethod = 'unknown',
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
          <AlertWeb tone="warning" className="mt-1 text-xs">
            Operations are disabled by server policy for this web instance.
          </AlertWeb>
        )}

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
