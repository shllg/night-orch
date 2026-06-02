import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { RunManager } from '../state/runs.js'
import { scanForReactions } from '../reactions/scanner.js'
import { handleReaction } from '../reactions/handler.js'
import type { ReactionEnvelope } from '../reactions/types.js'
import type { MetricsService } from '../metrics/service.js'
import type { OrchestrationCache } from './orchestration-cache.js'
import { logger } from '../utils/logger.js'

export interface ScanAndHandleReactionsParams {
  db: Database.Database
  forge: ForgeAdapter
  runManager: RunManager
  repoConfig: Config['repos'][0]
  maxAttemptChainLength: number
  cache: OrchestrationCache
  config: Config
  botUser: string
  metrics?: MetricsService
}

export async function scanAndHandleReactions(params: ScanAndHandleReactionsParams): Promise<void> {
  const { db, forge, runManager, repoConfig, maxAttemptChainLength, cache, config, botUser, metrics } = params
  const reviewBotAllowlist = new Set(config.commentCommands.reviewBotAllowlist ?? [])

  const rows = runManager
    .getActive()
    .filter((run) => run.repo === repoConfig.repo && run.status === 'review_ready' && run.prNumber !== null)
    .map((run) => ({
      id: run.id,
      repo: run.repo,
      issue_number: run.issueNumber,
      pr_number: run.prNumber as number,
    }))

  for (const row of rows) {
    const cursorKey = `${row.repo}#${row.issue_number}`
    const cursor = cache.reactionCursors.get(cursorKey)

    const result = await scanForReactions(
      forge,
      row.repo,
      row.pr_number,
      row.issue_number,
      cursor,
      {
        acceptMentions: config.commentCommands.acceptMentions,
        requireCollaborator: config.commentCommands.requireCollaborator,
        mentionAliases: config.commentCommands.mentionAliases,
        botUser,
        reviewBotAllowlist: config.commentCommands.reviewBotAllowlist,
      },
    )

    cache.reactionCursors.set(cursorKey, result.cursor)

    for (const reaction of result.reactions) {
      recordReactionMetrics(reaction, reviewBotAllowlist, metrics)
      try {
        await handleReaction(reaction, { db, forge, runManager, repoConfig, maxAttemptChainLength, botUser })
      } catch (err) {
        logger.warn(
          { repo: row.repo, issueNumber: row.issue_number, reactionType: reaction.type, err },
          'Failed to handle reaction',
        )
      }
    }
  }
}

function recordReactionMetrics(
  reaction: ReactionEnvelope,
  reviewBotAllowlist: ReadonlySet<string>,
  metrics: MetricsService | undefined,
): void {
  if (!metrics) return
  try {
    switch (reaction.type) {
      case 'mention_feedback':
        metrics.incMentionFeedback(reaction.locationKind)
        return
      case 'review_comment': {
        const counted = new Set<string>()
        for (const comment of reaction.comments) {
          if (counted.has(comment.user) || !reviewBotAllowlist.has(comment.user)) continue
          counted.add(comment.user)
          metrics.incReviewBotComments(comment.user)
        }
        return
      }
      case 'ci_failure':
      case 'human_review':
      case 'merge_conflict':
      case 'external_review':
        return
      default: {
        // Exhaustiveness: a new ReactionType added without updating this
        // switch will fail to compile.
        const _exhaustive: never = reaction
        void _exhaustive
      }
    }
  } catch { /* best-effort */ }
}
