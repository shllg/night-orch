export type NotificationEvent =
  | 'run_started'
  | 'blocked'
  | 'pr_ready'
  | 'pr_updated'
  | 'error'
  | 'retry_exhausted'

export interface NotificationPayload {
  event: NotificationEvent
  repo: string
  issueNumber: number
  issueTitle: string
  state: string
  prUrl: string | null
  prNumber: number | null
  summary: string
  blockingReason: string | null
  reviewSummary: string | null
  iterationCount: number
  timestamp: string
}

export interface NotificationChannel {
  readonly type: string
  send(payload: NotificationPayload): Promise<boolean>
  validate(): Promise<{ valid: boolean; error: string | null }>
}

export interface NotificationReport {
  sent: { channel: string; success: boolean; error: string | null }[]
  totalSent: number
  totalFailed: number
}
