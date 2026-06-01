import type { NotificationDispatcher } from '../notify/dispatcher.js'
import type { NotificationPayload } from '../notify/types.js'
import { makePayload } from '../runner/comment-formatting.js'

/**
 * Typed facade over `NotificationDispatcher` for the poller path.
 *
 * R6 goal: the attempt lifecycle shouldn't have to remember the string
 * keys used by `makePayload` or construct partial `NotificationPayload`
 * literals inline. Each method here corresponds to one event the
 * attempt dispatcher emits, with its own typed extras argument so the
 * compiler catches typos and missing fields.
 *
 * `NotificationDispatcher` stays the shared dispatch core (fanout over
 * configured channels, event filtering, error aggregation). This class
 * is a thin forwarding layer that exists only to improve call-site
 * readability inside the poller.
 */
export class PollerNotifier {
  constructor(private readonly inner: NotificationDispatcher) {}

  async runStarted(repo: string, issue: NotifyIssue): Promise<void> {
    await this.inner.dispatch(makePayload('run_started', repo, issue))
  }

  async prReady(
    repo: string,
    issue: NotifyIssue,
    extra?: PrReadyExtras,
  ): Promise<void> {
    await this.inner.dispatch(
      makePayload('pr_ready', repo, issue, coalesce(extra)),
    )
  }

  async blocked(
    repo: string,
    issue: NotifyIssue,
    extra?: BlockedExtras,
  ): Promise<void> {
    await this.inner.dispatch(
      makePayload('blocked', repo, issue, coalesce(extra)),
    )
  }

  async error(
    repo: string,
    issue: NotifyIssue,
    extra?: ErrorExtras,
  ): Promise<void> {
    await this.inner.dispatch(
      makePayload('error', repo, issue, coalesce(extra)),
    )
  }

  async retryExhausted(
    repo: string,
    issue: NotifyIssue,
    extra?: ErrorExtras,
  ): Promise<void> {
    await this.inner.dispatch(
      makePayload('retry_exhausted', repo, issue, coalesce(extra)),
    )
  }
}

export interface NotifyIssue {
  number: number
  title: string
  url?: string
}

interface PrReadyExtras {
  summary?: string
  prUrl?: string | null
  prNumber?: number | null
}

interface BlockedExtras {
  summary?: string
  blockingReason?: string | null
  reviewSummary?: string | null
}

interface ErrorExtras {
  summary?: string
}

function coalesce<T extends object>(value: T | undefined): Partial<NotificationPayload> {
  return (value ?? {}) as Partial<NotificationPayload>
}
