export type TabId = 'runs' | 'projects' | 'stats' | 'logs' | 'settings'

export type RunsViewMode = 'list' | 'focus'

export interface TuiLogLine {
  id: number
  createdAt: string
  level: 'info' | 'warn' | 'error'
  message: string
}
