export type NotificationEvent =
  | 'onRunStarted'
  | 'onBlocked'
  | 'onPrReady'
  | 'onError'
  | 'onRetryExhausted'

export interface Notification {
  event: NotificationEvent
  repo: string
  issueNumber: number
  title: string
  message: string
  url?: string
}

export interface NotificationChannel {
  send(notification: Notification): Promise<void>
}
