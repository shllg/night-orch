import type { NotificationChannel, NotificationPayload } from '../types.js'
import type { ForgeAdapter } from '../../forge/types.js'
import { logger } from '../../utils/logger.js'

export class GitHubCommentChannel implements NotificationChannel {
  readonly type = 'github-comment'

  constructor(private forge: ForgeAdapter) {}

  async send(payload: NotificationPayload): Promise<boolean> {
    if (!payload.issueNumber) {
      logger.debug({ repo: payload.repo }, 'No issue number — skipping GitHub comment notification')
      return true
    }

    const body = formatComment(payload)

    try {
      await this.forge.commentOnIssue(payload.repo, payload.issueNumber, body)
      return true
    } catch (err) {
      logger.warn({ repo: payload.repo, issue: payload.issueNumber, err }, 'Failed to post GitHub comment notification')
      return false
    }
  }

  async validate(): Promise<{ valid: boolean; error: string | null }> {
    try {
      await this.forge.validateAuth()
      return { valid: true, error: null }
    } catch (err) {
      return { valid: false, error: `Auth validation failed: ${(err as Error).message}` }
    }
  }
}

function formatComment(payload: NotificationPayload): string {
  const parts: string[] = []
  parts.push(`**[night-orch]** ${payload.event.replace(/_/g, ' ')}`)
  parts.push('')
  parts.push(payload.summary)

  if (payload.prUrl) {
    parts.push('')
    parts.push(`PR: ${payload.prUrl}`)
  }

  if (payload.blockingReason) {
    parts.push('')
    parts.push(`**Blocked:** ${payload.blockingReason}`)
  }

  if (payload.reviewSummary) {
    parts.push('')
    parts.push(`**Review:** ${payload.reviewSummary}`)
  }

  return parts.join('\n')
}
