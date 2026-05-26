import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { RunManager } from '../state/runs.js'
import { scanForReactions } from '../reactions/scanner.js'
import { handleReaction } from '../reactions/handler.js'
import type { ReactionCursor } from '../reactions/types.js'
import { logger } from '../utils/logger.js'

/** In-memory reaction cursors, keyed by "repo#issueNumber".
 *  Bounded: entries are evicted via cleanupRunCaches. */
export const reactionCursors = new Map<string, ReactionCursor>()

export interface ScanAndHandleReactionsParams {
  db: Database.Database
  forge: ForgeAdapter
  runManager: RunManager
  repoConfig: Config['repos'][0]
  maxAttemptChainLength: number
}

export async function scanAndHandleReactions(params: ScanAndHandleReactionsParams): Promise<void> {
  const { db, forge, runManager, repoConfig, maxAttemptChainLength } = params

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
    const cursor = reactionCursors.get(cursorKey)

    const result = await scanForReactions(
      forge,
      row.repo,
      row.pr_number,
      row.issue_number,
      cursor,
    )

    reactionCursors.set(cursorKey, result.cursor)

    for (const reaction of result.reactions) {
      try {
        await handleReaction(reaction, { db, forge, runManager, repoConfig, maxAttemptChainLength })
      } catch (err) {
        logger.warn(
          { repo: row.repo, issueNumber: row.issue_number, reactionType: reaction.type, err },
          'Failed to handle reaction',
        )
      }
    }
  }
}
