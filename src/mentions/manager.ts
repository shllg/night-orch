import type { RunContext } from '../loop/types.js'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type Database from 'better-sqlite3'
import { resolveMentions } from './resolver.js'
import { MentionTracker } from './tracker.js'
import { logger } from '../utils/logger.js'
import { runGit } from '../git/process.js'

export class PRMentionManager {
  private tracker: MentionTracker

  constructor(
    db: Database.Database,
    private forge: ForgeAdapter,
    private globalConfig: Config,
  ) {
    this.tracker = new MentionTracker(db)
  }

  async postMentions(ctx: RunContext, prNumber: number): Promise<void> {
    const mentionKeys = resolveMentions(
      ctx.issue.labels,
      ctx.repoConfig.defaults,
      this.globalConfig.github.appMentions,
    )

    if (mentionKeys.length === 0) return

    // Get current commit SHA
    let commitSha: string
    try {
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: ctx.worktreePath })
      commitSha = stdout.trim()
    } catch {
      logger.warn({ worktreePath: ctx.worktreePath }, 'Could not get commit SHA — skipping mentions')
      return
    }

    for (const key of mentionKeys) {
      if (this.tracker.wasPosted(ctx.repo, prNumber, key, commitSha)) {
        logger.debug({ key, prNumber, commitSha }, 'Mention already posted — skipping')
        continue
      }

      const mentionConfig = this.globalConfig.github.appMentions[key]
      const template = mentionConfig?.commentTemplate ?? `@${key}`
      const body = template
        .replace('{issue}', String(ctx.issueNumber))
        .replace('{pr}', String(prNumber))
        .replace('{repo}', ctx.repo)

      try {
        await this.forge.commentOnIssue(ctx.repo, prNumber, body)
        this.tracker.recordPosted(ctx.repo, prNumber, key, commitSha)
        logger.info({ key, prNumber }, 'Posted mention comment')
      } catch (err) {
        logger.warn({ key, prNumber, err }, 'Failed to post mention comment')
      }
    }
  }
}
