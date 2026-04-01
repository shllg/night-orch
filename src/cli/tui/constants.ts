import type { TabId } from './types.js'

export const TABS: Array<{ id: TabId; hotkey: string; label: string }> = [
  { id: 'runs', hotkey: '1', label: 'Issues' },
  { id: 'projects', hotkey: '2', label: 'Projects' },
  { id: 'stats', hotkey: '3', label: 'Stats' },
  { id: 'logs', hotkey: '4', label: 'Logs' },
]

export const STATUS_COLORS: Record<string, 'white' | 'yellow' | 'cyan' | 'magenta' | 'green' | 'red'> = {
  running: 'yellow',
  queued: 'cyan',
  review_ready: 'magenta',
  completed: 'green',
  blocked: 'red',
  error: 'red',
}

export const EVENT_COLORS: Record<string, 'gray' | 'cyan' | 'green' | 'yellow' | 'red' | 'magenta'> = {
  session_start: 'green',
  session_end: 'green',
  text: 'gray',
  tool_call: 'cyan',
  tool_result: 'magenta',
  thinking: 'yellow',
  turn_complete: 'yellow',
  error: 'red',
}
