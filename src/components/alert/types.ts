import type { ReactNode } from 'react'
import type { Tone } from '../shared-types.js'

export type AlertTone = Extract<Tone, 'neutral' | 'info' | 'success' | 'warning' | 'error'>

/**
 * ARIA role for the alert container.
 *
 * - `'status'` (default) — polite live-region, appropriate for passive
 *   empty states and progress messages. Does not interrupt assistive tech.
 * - `'alert'` — assertive live-region, reserved for errors and warnings
 *   that require immediate attention.
 * - `'none'` — no live-region semantics; render as a plain container.
 */
export type AlertRole = 'status' | 'alert' | 'none'

export interface AlertProps {
  tone?: AlertTone
  role?: AlertRole
  icon?: ReactNode
  title?: ReactNode
  children?: ReactNode
  className?: string
}

export interface AlertViewModel {
  tone: AlertTone
  webClassName: string
}
