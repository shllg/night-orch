import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { formatStatusComment } from '../forge/status-comment.js'
import { buildLabelConfig } from '../labels/config.js'
import { transitionLabels } from '../labels/manager.js'
import type { BlockedReason } from '../loop/state.js'
import { postStatusComment } from '../runner/comment-formatting.js'
import type { RunManager, RunStateTransitionFields, RunStatus } from '../state/runs.js'
import { nowUtcIso } from '../utils/time.js'
import type { PollerNotifier, NotifyIssue } from './notify-dispatcher.js'

export interface RunStateControllerParams {
  forge: ForgeAdapter
  repoConfig: Config['repos'][number]
  issueRepo: string
  issue: NotifyIssue & { labels?: string[] }
  runManager: RunManager
  pollerNotifier: PollerNotifier
  botUser: string
}

export interface BlockedTransitionParams {
  from: RunStatus
  fields: Omit<RunStateTransitionFields, 'status' | 'endedAt'>
  labelReason?: BlockedReason
  comment?: {
    body: string
    warnMessage: string
  }
  notification?: {
    summary?: string
    blockingReason?: string | null
    reviewSummary?: string | null
  } | false
}

export interface ErrorTransitionParams {
  from: RunStatus
  fields: Omit<RunStateTransitionFields, 'status' | 'endedAt'>
  comment?: {
    body: string
    warnMessage: string
  }
  notification?: {
    summary?: string
  }
}

export interface ReviewReadyTransitionParams {
  from: RunStatus
  fields?: Omit<RunStateTransitionFields, 'status' | 'endedAt'>
  notification?: {
    summary?: string
    prUrl?: string | null
    prNumber?: number | null
  }
}

export class RunStateController {
  private latestIssuePromise: ReturnType<ForgeAdapter['getIssue']> | null = null

  constructor(private readonly params: RunStateControllerParams) {}

  async markBlocked(runId: string, transition: BlockedTransitionParams): Promise<void> {
    this.params.runManager.transitionRunState(runId, {
      ...transition.fields,
      status: 'blocked',
      endedAt: nowUtcIso(),
    })
    await this.transitionIssueLabels(transition.from, 'blocked', transition.labelReason)
    if (transition.comment) {
      await this.postComment(transition.comment)
    }
    if (transition.notification !== false) {
      await this.params.pollerNotifier.blocked(
        this.params.repoConfig.repo,
        this.params.issue,
        transition.notification,
      )
    }
  }

  async markError(runId: string, transition: ErrorTransitionParams): Promise<void> {
    this.params.runManager.transitionRunState(runId, {
      ...transition.fields,
      status: 'error',
      endedAt: nowUtcIso(),
    })
    await this.transitionIssueLabels(transition.from, 'error')
    if (transition.comment) {
      await this.postComment(transition.comment)
    }
    await this.params.pollerNotifier.error(
      this.params.repoConfig.repo,
      this.params.issue,
      transition.notification,
    )
  }

  async markReviewReady(runId: string, transition: ReviewReadyTransitionParams): Promise<void> {
    this.params.runManager.transitionRunState(runId, {
      ...(transition.fields ?? {}),
      status: 'review_ready',
      endedAt: nowUtcIso(),
      lastError: transition.fields?.lastError ?? null,
    })
    await this.transitionIssueLabels(transition.from, 'review_ready')
    if (transition.notification) {
      await this.params.pollerNotifier.prReady(
        this.params.repoConfig.repo,
        this.params.issue,
        transition.notification,
      )
    }
  }

  async markRunning(runId: string, fields: Omit<RunStateTransitionFields, 'status'>, from: RunStatus): Promise<void> {
    this.params.runManager.transitionRunState(runId, {
      ...fields,
      status: 'running',
    })
    await transitionLabels(
      this.params.forge,
      this.params.issueRepo,
      this.params.issue.number,
      this.params.issue.labels ?? [],
      from,
      'running',
      buildLabelConfig(this.params.repoConfig, this.params.issue.labels ?? []),
    )
    await this.params.pollerNotifier.runStarted(this.params.repoConfig.repo, this.params.issue)
  }

  private async transitionIssueLabels(
    from: RunStatus,
    to: RunStatus,
    blockReason?: BlockedReason,
  ): Promise<void> {
    const latestIssue = await this.getLatestIssue()
    await transitionLabels(
      this.params.forge,
      this.params.issueRepo,
      this.params.issue.number,
      latestIssue.labels,
      from,
      to,
      buildLabelConfig(this.params.repoConfig, latestIssue.labels),
      blockReason,
    )
  }

  private getLatestIssue(): ReturnType<ForgeAdapter['getIssue']> {
    this.latestIssuePromise ??= this.params.forge.getIssue(this.params.issueRepo, this.params.issue.number)
    return this.latestIssuePromise
  }

  private async postComment(comment: { body: string; warnMessage: string }): Promise<void> {
    await postStatusComment({
      forge: this.params.forge,
      issueRepo: this.params.issueRepo,
      issueNumber: this.params.issue.number,
      botUser: this.params.botUser,
      body: comment.body,
      warnMessage: comment.warnMessage,
    })
  }
}

export function blockedStatusComment(params: {
  blockReason: string
  nextStep?: string
}): string {
  return formatStatusComment(params)
}
