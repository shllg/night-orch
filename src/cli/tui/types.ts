export type TabId = 'runs' | 'stats' | 'logs'

export type RunsViewMode = 'list' | 'focus'

export interface TuiLogLine {
  id: number
  createdAt: string
  level: 'info' | 'warn' | 'error'
  message: string
}
