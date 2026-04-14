import type { ReactNode } from 'react'

/**
 * Source of a log entry. Used to pick a color accent in the row.
 * - `system` — orchestration/engine output (secondary tone)
 * - `agent`  — worker/agent output (info tone)
 */
export type LogLineSource = 'system' | 'agent'

export interface LogLineProps {
  /** Preformatted timestamp string — caller controls the format. */
  timestamp: string
  source: LogLineSource
  /** Short label for the source (e.g. agent role). Falls back to the source name. */
  role?: string
  message: ReactNode
  className?: string
}

export interface LogLineViewModel {
  containerClassName: string
  sourceClassName: string
  sourceLabel: string
}
