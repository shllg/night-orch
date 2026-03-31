export type AgentEventType =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'turn_complete'
  | 'error'
  | 'session_start'
  | 'session_end'

export interface AgentEvent {
  id?: number
  runId: string
  phase: string
  role: string
  type: AgentEventType
  timestamp: string
  data: {
    text?: string
    toolName?: string
    toolArgs?: string
    tokenCount?: number
    error?: string
    [key: string]: unknown
  }
}

