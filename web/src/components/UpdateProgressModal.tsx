import { type ReactElement } from 'react'
import { createPortal } from 'react-dom'

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

interface UpdateProgressOverlayProps {
  status: UpdateStatus
  serverUnreachable?: boolean
}

/**
 * The visual content of the update modal. Extracted so it can be tested
 * with renderToStaticMarkup (which does not support portals).
 */
export function UpdateProgressOverlay({
  status,
  serverUnreachable = false,
}: UpdateProgressOverlayProps): ReactElement {
  return (
    <div
      data-theme="black"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'grid',
        placeItems: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(4px)',
        padding: '1rem',
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Self update in progress"
    >
      <section className="w-full max-w-xl rounded-box border border-base-300/80 bg-base-100/95 p-5 shadow-2xl">
        <h2 className="text-lg font-semibold">Applying self-update</h2>
        <p className="mt-1 text-sm text-base-content/75">
          Current stage: {formatUpdateState(status.state)}
        </p>

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

        {serverUnreachable && (
          <div className="mt-4 rounded border border-info/35 bg-info/10 p-2 text-xs text-info-content">
            Server is restarting — status will refresh automatically when it comes back.
          </div>
        )}

        {status.state === 'rolling-back' && (
          <div className="mt-4 rounded border border-warning/35 bg-warning/10 p-2 text-xs text-warning-content">
            Health checks failed. Rolling back to the previous known-good build.
          </div>
        )}

        <p className="mt-4 text-xs text-base-content/70">
          Dashboard controls are temporarily blocked. This page refreshes automatically after a
          healthy restart.
        </p>
      </section>
    </div>
  )

}

/**
 * Full-screen update progress overlay. Rendered via a React portal directly
 * into `document.body` to avoid any ancestor `overflow`, `contain`, or
 * stacking-context issues that could break `position: fixed`. Uses inline
 * styles for the overlay so it works even if DaisyUI's `.modal` layer is
 * not applied (Tailwind v4 + DaisyUI v5 layer ordering can be fragile).
 */
export function UpdateProgressModal(props: UpdateProgressOverlayProps): ReactElement {
  return createPortal(<UpdateProgressOverlay {...props} />, document.body)
}
