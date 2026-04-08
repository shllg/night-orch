import { type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { type UpdateStatus } from '../types/dashboard.js'

interface UpdateStep {
  id: string
  label: string
}

const GIT_STEPS: UpdateStep[] = [
  { id: 'draining', label: 'Draining running services' },
  { id: 'pulling', label: 'Pulling latest code' },
  { id: 'building', label: 'Installing and building' },
  { id: 'restarting', label: 'Restarting supervisor' },
  { id: 'health-checking', label: 'Running health checks' },
]

const NPM_STEPS: UpdateStep[] = [
  { id: 'draining', label: 'Draining running services' },
  { id: 'pulling', label: 'Checking npm registry' },
  { id: 'building', label: 'Installing package globally' },
  { id: 'restarting', label: 'Restarting supervisor' },
  { id: 'health-checking', label: 'Running health checks' },
]

/** State id order used by App.tsx fake-progress advancement. */
export const GIT_STATE_ORDER = GIT_STEPS.map((s) => s.id)
export const NPM_STATE_ORDER = NPM_STEPS.map((s) => s.id)

function getStepsForMethod(method: 'git' | 'npm' | undefined): UpdateStep[] {
  return method === 'npm' ? NPM_STEPS : GIT_STEPS
}

function getStepStatus(
  stepId: string,
  currentState: string,
  steps: UpdateStep[],
): 'pending' | 'active' | 'done' {
  const currentIndex = steps.findIndex((step) => step.id === currentState)
  if (currentIndex < 0) return 'pending'

  const stepIndex = steps.findIndex((step) => step.id === stepId)
  if (stepIndex < currentIndex) return 'done'
  if (stepIndex === currentIndex) return 'active'
  return 'pending'
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

interface UpdateProgressOverlayProps {
  status: UpdateStatus
  serverUnreachable?: boolean
  elapsedSeconds?: number
}

const PULSE_STYLE = `
.update-step-active::before {
  animation: update-pulse 1.5s ease-in-out infinite;
}
@keyframes update-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
`

/**
 * The visual content of the update modal. Extracted so it can be tested
 * with renderToStaticMarkup (which does not support portals).
 */
export function UpdateProgressOverlay({
  status,
  serverUnreachable = false,
  elapsedSeconds,
}: UpdateProgressOverlayProps): ReactElement {
  const steps = getStepsForMethod(status.installMethod)

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
      <style>{PULSE_STYLE}</style>

      <section className="w-full max-w-xl rounded-box border border-base-300/80 bg-base-100/95 p-5 shadow-2xl">
        <h2 className="text-lg font-semibold">Applying self-update</h2>

        {(status.previousCommit || status.targetCommit) && (
          <p className="mt-1 font-mono text-xs text-base-content/60">
            {status.previousCommit?.slice(0, 8)}
            {status.targetCommit && <> &rarr; {status.targetCommit.slice(0, 8)}</>}
          </p>
        )}

        <div className="mt-3 flex items-center gap-3 text-sm text-base-content/80">
          <span className="loading loading-spinner loading-md text-info" />
          <span>
            Update in progress
            {elapsedSeconds != null && elapsedSeconds > 0 && (
              <> &mdash; {formatElapsed(elapsedSeconds)}</>
            )}
          </span>
        </div>

        <ul className="steps steps-vertical mt-4 w-full">
          {steps.map((step) => {
            const s = getStepStatus(step.id, status.state, steps)
            const stepClass =
              s === 'done'
                ? 'step step-success'
                : s === 'active'
                  ? 'step step-info update-step-active'
                  : 'step'
            const dataContent = s === 'done' ? '\u2713' : s === 'active' ? '\u25CF' : '\u25CB'

            return (
              <li key={step.id} className={stepClass} data-content={dataContent}>
                <span className={s === 'pending' ? 'text-base-content/50' : undefined}>
                  {step.label}
                </span>
              </li>
            )
          })}
        </ul>

        {serverUnreachable && (
          <div className="mt-4 flex items-center gap-2 rounded border border-info/35 bg-info/10 p-2.5 text-xs text-info-content">
            <span className="loading loading-dots loading-xs" />
            <span>Server is restarting — reconnecting automatically...</span>
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
