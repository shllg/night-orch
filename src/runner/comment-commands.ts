import type { Config } from '../config/schema.js'
import type Database from 'better-sqlite3'
import type { RunManager } from '../state/runs.js'
import type { LeaseManager } from '../state/leases.js'
import type { ForgeAdapter, ForgeComment } from '../forge/types.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { queueRebase } from '../ops/rebase-and-check.js'
import { queueContinue } from '../ops/continue.js'
import { RetryEngine } from '../ops/retry.js'
import type { OrchestrationCache } from './orchestration-cache.js'
import {
  isCommandProcessed,
  markCommandProcessed,
  parseOrchCommands,
  stripCodeBlocks,
  type OrchCommand,
} from '../discovery/commands.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { isBotAuthored } from '../forge/bot-comment.js'
import { nowUtcIso } from '../utils/time.js'
import { logger } from '../utils/logger.js'

export interface ProcessCommentCommandsParams {
  config: Config
  db: Database.Database
  forge: ForgeAdapter
  runManager: RunManager
  leaseManager: LeaseManager
  repoConfig: Config['repos'][0]
  botUser: string
  cache: OrchestrationCache
}

export interface MentionMatch {
  commentId: number
  user: string
  body: string
  alias: string
}

export function parseMentions(comments: ForgeComment[], aliases: readonly string[]): MentionMatch[] {
  const normalizedAliases = [...new Set(aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0))]
    .sort((a, b) => b.length - a.length)
  if (normalizedAliases.length === 0) return []

  const results: MentionMatch[] = []
  for (const comment of comments) {
    if (isBotAuthored(comment.body)) continue
    const cleaned = stripCodeBlocks(comment.body)
    const alias = normalizedAliases.find((candidate) => cleaned.includes(candidate))
    if (!alias) continue
    results.push({
      commentId: comment.id,
      user: comment.user,
      body: comment.body,
      alias,
    })
  }
  return results
}

function getHttpStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { status?: unknown; response?: { status?: unknown } }
  if (typeof e.status === 'number') return e.status
  if (typeof e.response?.status === 'number') return e.response.status
  return null
}

/**
 * Collect every source where a `/orch` command could be posted for a run:
 * the issue's conversation comments plus — when the run has an open PR —
 * the PR's review bodies and inline review comments. Bot-authored content
 * (detected by HTML marker) is filtered out so the command parser never
 * re-executes a command night-orch echoed in a status comment.
 */
export async function collectCommentSources(
  forge: ForgeAdapter,
  issueRepo: string,
  issueNumber: number,
  prNumber: number | null,
): Promise<ForgeComment[]> {
  const out: ForgeComment[] = []

  const issueComments = await forge.listIssueComments(issueRepo, issueNumber)
  out.push(...issueComments)

  if (prNumber !== null) {
    const [reviews, reviewComments] = await Promise.all([
      forge.listPRReviews(issueRepo, prNumber).catch(() => []),
      forge.listPRReviewComments(issueRepo, prNumber).catch(() => []),
    ])
    for (const r of reviews) {
      if (!r.body?.trim()) continue
      out.push({ id: r.id, body: r.body, user: r.user, createdAt: r.submittedAt, updatedAt: r.submittedAt })
    }
    for (const c of reviewComments) {
      out.push({ id: c.id, body: c.body, user: c.user, createdAt: c.createdAt, updatedAt: c.createdAt })
    }
  }

  return out.filter((c) => !isBotAuthored(c.body))
}

export async function processCommentCommands(params: ProcessCommentCommandsParams): Promise<void> {
  const {
    config,
    db,
    forge,
    runManager,
    leaseManager,
    repoConfig,
    botUser,
    cache,
  } = params

  const commandSettings = config.commentCommands ?? { enabled: true, requireCollaborator: true }
  if (!commandSettings.enabled) return
  if (config.commentCommands && commandSettings.requireCollaborator === false) {
    logger.warn(
      { repo: repoConfig.repo },
      'commentCommands.requireCollaborator=false — /orch commands accept any commenter. Enable on public repos.',
    )
  }

  const activeRuns = runManager
    .getActive()
    .filter((run) => run.repo === repoConfig.repo)

  const issueRows = [...new Map(
    activeRuns.map((run) => {
      const issueRepo = resolveIssueRepo(run.phaseData, repoConfig.repo)
      return [
        `${issueRepo}#${run.issueNumber}`,
        { issue_number: run.issueNumber, issue_repo: issueRepo, pr_number: run.prNumber ?? null },
      ] as const
    }),
  ).values()]
    .sort((a, b) => a.issue_repo.localeCompare(b.issue_repo) || a.issue_number - b.issue_number)

  if (issueRows.length === 0) return

  const collaboratorCache = new Map<string, boolean>()

  for (const row of issueRows) {
    const issueKey = `${row.issue_repo}#${row.issue_number}`
    if (cache.missingCommentCommandIssues.has(issueKey)) {
      continue
    }

    let comments: ForgeComment[]
    try {
      comments = await collectCommentSources(forge, row.issue_repo, row.issue_number, row.pr_number)
    } catch (err) {
      if (getHttpStatus(err) === 404) {
        cache.missingCommentCommandIssues.add(issueKey)
        logger.debug(
          { repo: row.issue_repo, issueNumber: row.issue_number },
          'Skipping comment command scan for missing or inaccessible issue',
        )
        continue
      }
      throw err
    }
    const parsed = parseOrchCommands(comments, '1970-01-01T00:00:00Z')

    for (const item of parsed) {
      if (isCommandProcessed(db, row.issue_repo, row.issue_number, item.commentId)) continue

      let commandStatus: string | null = null
      try {
        const allowed = await canExecuteCommentCommand({
          forge,
          repo: row.issue_repo,
          user: item.user,
          requireCollaborator: commandSettings.requireCollaborator,
          cache: collaboratorCache,
        })

        if (!allowed) {
          commandStatus = 'denied'
          logger.info(
            { repo: repoConfig.repo, issueNumber: row.issue_number, user: item.user, commentId: item.commentId },
            'Ignoring comment command from non-collaborator',
          )
          continue
        }

        const result = await executeCommentCommand({
          command: item.command,
          config,
          db,
          forge,
          runManager,
          leaseManager,
          repoConfig,
          issueRepo: row.issue_repo,
          issueNumber: row.issue_number,
          botUser,
          user: item.user,
        })

        if (!result.ok) {
          commandStatus = 'rejected'
          logger.info(
            { repo: repoConfig.repo, issueNumber: row.issue_number, command: item.command.type, reason: result.reason },
            'Comment command rejected',
          )
        } else {
          commandStatus = 'applied'
          logger.info(
            { repo: repoConfig.repo, issueNumber: row.issue_number, command: item.command.type, user: item.user },
            'Comment command applied',
          )
        }
      } catch (err) {
        logger.warn(
          { repo: repoConfig.repo, issueNumber: row.issue_number, commentId: item.commentId, command: item.command.type, err },
          'Comment command failed (transient — will retry)',
        )
      } finally {
        if (commandStatus !== null) {
          markCommandProcessed(
            db,
            row.issue_repo,
            row.issue_number,
            item.commentId,
            `${item.command.type}:${commandStatus}`,
          )
        }
      }
    }
  }
}

interface CanExecuteCommentCommandParams {
  forge: ForgeAdapter
  repo: string
  user: string
  requireCollaborator: boolean
  cache: Map<string, boolean>
}

async function canExecuteCommentCommand(params: CanExecuteCommentCommandParams): Promise<boolean> {
  const { forge, repo, user, requireCollaborator, cache } = params
  if (!requireCollaborator) return true
  if (!user) return false

  const cacheKey = `${repo}\n${user}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached

  if (!forge.isCollaborator) {
    logger.warn({ repo, user }, 'requireCollaborator=true but forge adapter has no isCollaborator() implementation')
    cache.set(cacheKey, false)
    return false
  }

  try {
    const allowed = await forge.isCollaborator(repo, user)
    cache.set(cacheKey, allowed)
    return allowed
  } catch (err) {
    logger.warn({ repo, user, err }, 'Failed collaborator check for comment command user')
    cache.set(cacheKey, false)
    return false
  }
}

interface ExecuteCommentCommandParams {
  command: OrchCommand
  config: Config
  db: Database.Database
  forge: ForgeAdapter
  runManager: RunManager
  leaseManager: LeaseManager
  repoConfig: Config['repos'][0]
  issueRepo: string
  issueNumber: number
  botUser: string
  user: string
}

type CommandExecutionResult = { ok: true } | { ok: false; reason: string }

async function executeCommentCommand(params: ExecuteCommentCommandParams): Promise<CommandExecutionResult> {
  const {
    command,
    config,
    db,
    forge,
    runManager,
    leaseManager,
    repoConfig,
    issueRepo,
    issueNumber,
    botUser,
    user,
  } = params

  switch (command.type) {
    case 'retry':
      return queueRetryFromComment({
        config,
        db,
        runManager,
        repoConfig,
        issueNumber,
      })
    case 'continue':
      {
        const result = await queueContinue(db, forge, repoConfig, issueNumber, botUser, {
          issueRepo,
          maxAttemptChainLength: config.loop.maxAttemptChainLength,
        })
        return result.queued ? { ok: true } : { ok: false, reason: result.reason }
      }
    case 'rebase': {
      const result = await queueRebase({
        db,
        forge,
        repoConfig,
        issueNumber,
        botUser,
        trigger: { kind: 'comment', user },
        maxAttemptChainLength: config.loop.maxAttemptChainLength,
      })
      return result.queued ? { ok: true } : { ok: false, reason: result.reason }
    }
    case 'cancel':
      return cancelRunFromComment({
        runManager,
        leaseManager,
        forge,
        repoConfig,
        issueRepo,
        issueNumber,
        user,
      })
    default: {
      const exhaustive: never = command
      return { ok: false, reason: `Unsupported command: ${String(exhaustive)}` }
    }
  }
}

interface QueueRetryFromCommentParams {
  config: Config
  db: Database.Database
  runManager: RunManager
  repoConfig: Config['repos'][0]
  issueNumber: number
}

async function queueRetryFromComment(params: QueueRetryFromCommentParams): Promise<CommandExecutionResult> {
  const { config, db, runManager, repoConfig, issueNumber } = params
  const run = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (!run) return { ok: false, reason: 'No run found for issue' }
  if (run.status === 'running') return { ok: false, reason: 'Run is currently running' }
  if (!['blocked', 'error', 'review_ready'].includes(run.status)) {
    return { ok: false, reason: `Retry not allowed from status ${run.status}` }
  }

  const engine = new RetryEngine(db, config)
  await engine.retry(repoConfig.repo, issueNumber, {
    immediate: false,
    dryRun: false,
    resetPlan: true,
    resetBranch: true,
  })

  return { ok: true }
}

interface CancelRunFromCommentParams {
  runManager: RunManager
  leaseManager: LeaseManager
  forge: ForgeAdapter
  repoConfig: Config['repos'][0]
  issueRepo: string
  issueNumber: number
  user: string
}

async function cancelRunFromComment(params: CancelRunFromCommentParams): Promise<CommandExecutionResult> {
  const { runManager, leaseManager, forge, repoConfig, issueRepo, issueNumber, user } = params
  const run = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (!run) return { ok: false, reason: 'No run found for issue' }
  if (run.status !== 'running' && run.status !== 'queued') {
    return { ok: false, reason: `Cancel only supports running/queued runs (current: ${run.status})` }
  }

  runManager.updateLifecycle(run.id, {
    status: 'blocked',
    endedAt: nowUtcIso(),
    lastError: `Cancelled by @${user} via comment command`,
    blockReason: null,
  })
  leaseManager.release(issueRepo, issueNumber)
  if (issueRepo !== repoConfig.repo) {
    leaseManager.release(repoConfig.repo, issueNumber)
  }

  const issue = await forge.getIssue(issueRepo, issueNumber)
  await transitionLabels(
    forge,
    issueRepo,
    issueNumber,
    issue.labels,
    run.status,
    'blocked',
    buildLabelConfig(repoConfig, issue.labels),
  )
  return { ok: true }
}
