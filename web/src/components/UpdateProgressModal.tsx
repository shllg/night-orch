import { type ReactElement } from 'react'

import { ModalWeb } from '../../../src/components/modal/modal.web.js'
import { type UpdateStatus } from '../types/dashboard.js'

const UPDATE_STEPS = [
  { id: 'draining', label: 'Draining running services' },
  { id: 'pulling', label: 'Pulling latest code' },
  { id: 'building', label: 'Installing and building' },
  { id: 'restarting', label: 'Restarting supervisor children' },
  { id: 'health-checking', label: 'Running health checks' },
] as const

type UpdateStepId = (typeof UPDATE_STEPS)[number]['id']

function formatUpdateState(value: string): string {
  return value
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function getStepStatus(
  stepId: UpdateStepId,
  currentState: string,
): 'pending' | 'active' | 'done' {
  const currentIndex = UPDATE_STEPS.findIndex((step) => step.id === currentState)
  if (currentIndex < 0) {
    return 'pending'
  }

  const stepIndex = UPDATE_STEPS.findIndex((step) => step.id === stepId)
  if (stepIndex < currentIndex) {
    return 'done'
  }
  if (stepIndex === currentIndex) {
    return 'active'
  }
  return 'pending'
}

export function UpdateProgressModal({ status }: { status: UpdateStatus }): ReactElement {
  return (
    <ModalWeb
      open
      title="Applying self-update"
      description={`Current stage: ${formatUpdateState(status.state)}`}
      ariaLabel="Self update in progress"
      blocking
      widthClassName="max-w-xl"
    >
      <div className="mt-3 flex items-center gap-3 text-sm text-base-content/80">
        <span className="loading loading-spinner loading-md text-info" />
        <span>Update workflow is running and cannot be interrupted.</span>
      </div>

      <ul className="mt-4 space-y-2">
        {UPDATE_STEPS.map((step) => {
          const stepStatus = getStepStatus(step.id, status.state)
          const badgeTone =
            stepStatus === 'active'
              ? 'badge-info'
              : stepStatus === 'done'
                ? 'badge-success'
                : 'badge-ghost'
          const badgeLabel =
            stepStatus === 'active'
              ? 'live'
              : stepStatus === 'done'
                ? 'done'
                : 'pending'

          return (
            <li key={step.id} className="flex items-center justify-between gap-3 text-sm">
              <span className={stepStatus === 'pending' ? 'text-base-content/65' : undefined}>
                {step.label}
              </span>
              <span className={`badge badge-sm ${badgeTone}`}>{badgeLabel}</span>
            </li>
          )
        })}
      </ul>

      {status.state === 'rolling-back' && (
        <div className="mt-4 rounded border border-warning/35 bg-warning/10 p-2 text-xs text-warning-content">
          Health checks failed. Rolling back to the previous known-good build.
        </div>
      )}

      <p className="mt-4 text-xs text-base-content/70">
        Dashboard controls are temporarily blocked. This page refreshes automatically after a
        healthy restart.
      </p>
    </ModalWeb>
  )
}
