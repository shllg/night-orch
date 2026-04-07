import type { Config } from '../config/schema.js'
import type Database from 'better-sqlite3'
import type { RunManager } from '../state/runs.js'
import type { LeaseManager } from '../state/leases.js'
import type { ForgeAdapter } from '../forge/types.js'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import { queueRebase } from '../ops/rebase-and-check.js'
import { queueContinue } from '../ops/continue.js'
import {
  isCommandProcessed,
  markCommandProcessed,
  parseOrchCommands,
  type OrchCommand,
} from '../discovery/commands.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { nowUtcIso } from '../utils/time.js'
import { logger } from '../utils/logger.js'

/** Issues that returned 404 during comment scan in this process lifecycle.
 *  Bounded: entries are evicted when the key's run reaches a terminal state
 *  via cleanupRunCaches. */
export const missingCommentCommandIssues = new Set<string>()

export interface ProcessCommentCommandsParams {
  config: Config
  db: Database.Database
  forge: ForgeAdapter
  runManager: RunManager
  leaseManager: LeaseManager
  repoConfig: Config['repos'][0]
  botUser: string
}

function getHttpStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { status?: unknown; response?: { status?: unknown } }
  if (typeof e.status === 'number') return e.status
  if (typeof e.response?.status === 'number') return e.response.status
  return null
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
  } = params

  const commandSettings = config.commentCommands ?? { enabled: true, requireCollaborator: false }
  if (!commandSettings.enabled) return
  if (!commandSettings.requireCollaborator) {
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
      return [`${issueRepo}#${run.issueNumber}`, { issue_number: run.issueNumber, issue_repo: issueRepo }] as const
    }),
  ).values()]
    .sort((a, b) => a.issue_repo.localeCompare(b.issue_repo) || a.issue_number - b.issue_number)

  if (issueRows.length === 0) return

  const collaboratorCache = new Map<string, boolean>()

  for (const row of issueRows) {
    const issueKey = `${row.issue_repo}#${row.issue_number}`
    if (missingCommentCommandIssues.has(issueKey)) {
      continue
    }

    let comments: Awaited<ReturnType<typeof forge.listIssueComments>>
    try {
      comments = await forge.listIssueComments(row.issue_repo, row.issue_number)
    } catch (err) {
      if (getHttpStatus(err) === 404) {
        missingCommentCommandIssues.add(issueKey)
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
        runManager,
        leaseManager,
        forge,
        repoConfig,
        issueRepo,
        issueNumber,
        resetPlan: command.resetPlan,
      })
    case 'continue':
      {
        const result = await queueContinue(db, forge, repoConfig, issueNumber, botUser, { issueRepo })
        return result.queued ? { ok: true } : { ok: false, reason: result.reason }
      }
    case 'rebase': {
      const result = await queueRebase(db, forge, repoConfig, issueNumber, botUser)
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
  runManager: RunManager
  leaseManager: LeaseManager
  forge: ForgeAdapter
  repoConfig: Config['repos'][0]
  issueRepo: string
  issueNumber: number
  resetPlan: boolean
}

async function queueRetryFromComment(params: QueueRetryFromCommentParams): Promise<CommandExecutionResult> {
  const { runManager, leaseManager, forge, repoConfig, issueRepo, issueNumber, resetPlan } = params
  const run = runManager.getByRepoAndIssue(repoConfig.repo, issueNumber)
  if (!run) return { ok: false, reason: 'No run found for issue' }
  if (run.status === 'running') return { ok: false, reason: 'Run is currently running' }
  if (!['blocked', 'error', 'review_ready'].includes(run.status)) {
    return { ok: false, reason: `Retry not allowed from status ${run.status}` }
  }

  runManager.update(run.id, {
    status: 'queued',
    currentPhase: null,
    endedAt: null,
    lastError: null,
    phaseData: resetPlan ? null : run.phaseData,
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
    'queued',
    buildLabelConfig(repoConfig, issue.labels),
  )
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

  runManager.update(run.id, {
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
