export type TabId = 'runs' | 'projects' | 'stats' | 'logs' | 'settings' | 'fileloop'

export type RunsViewMode = 'list' | 'focus'
export type ProjectsViewMode = 'list' | 'focus'

export interface TuiLogLine {
  id: number
  createdAt: string
  level: 'info' | 'warn' | 'error'
  message: string
}
