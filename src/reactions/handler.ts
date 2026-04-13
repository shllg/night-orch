import type { Reaction } from './types.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { RunManager } from '../state/runs.js'
import type Database from 'better-sqlite3'
import { transitionLabels } from '../labels/manager.js'
import { buildLabelConfig } from '../labels/config.js'
import type { RepoConfig } from '../config/schema.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { logger } from '../utils/logger.js'
import { createFollowupAttempt, AttemptTerminatedError, AttemptNotFoundError } from '../state/attempts.js'
import { recordUserAction } from '../state/run-log-events.js'

export interface ReactionHandlerDeps {
  db: Database.Database
  forge: ForgeAdapter
  runManager: RunManager
  repoConfig: Pick<RepoConfig, 'labels' | 'kanban'>
}

/**
 * Handle a reaction by queuing a follow-up run. Merge-conflict reactions
 * create a new attempt with `intent='rebase'` so the poller drives the
 * rebase-and-re-verify flow; all other reaction types flip the current
 * run in place back to `queued` and seed reaction context on phase data.
 */
export async function handleReaction(
  reaction: Reaction,
  deps: ReactionHandlerDeps,
): Promise<void> {
  const { db, forge, runManager, repoConfig } = deps

  logger.info(
    { repo: reaction.repo, prNumber: reaction.prNumber, issueNumber: reaction.issueNumber, type: reaction.type },
    `Handling reaction: ${reaction.summary}`,
  )

  // Find the latest run for this issue
  const run = runManager.getByRepoAndIssue(reaction.repo, reaction.issueNumber)
  if (!run) {
    logger.warn({ repo: reaction.repo, issueNumber: reaction.issueNumber }, 'No run found for reaction — skipping')
    return
  }

  // Only react to runs that are in review_ready state (PR has been created)
  if (run.status !== 'review_ready') {
    logger.debug(
      { repo: reaction.repo, issueNumber: reaction.issueNumber, status: run.status },
      'Run not in review_ready state — skipping reaction',
    )
    return
  }

  const issueRepo = resolveIssueRepo(run.phaseData, reaction.repo)
  const existingPhaseData = run.phaseData ?? {}

  if (reaction.type === 'merge_conflict') {
    try {
      const result = createFollowupAttempt(db, {
        previousAttemptId: run.id,
        intent: 'rebase',
        resetBranch: false,
        phaseData: {
          ...existingPhaseData,
          issueRepo,
          reactionContext: reaction.context,
          reactionType: reaction.type,
          reactionSummary: reaction.summary,
        },
        controlPayload: {
          issueRepo,
          checkAfter: true,
          requestedAt: new Date().toISOString(),
          preserveBranchState: true,
        },
      })
      recordUserAction(db, {
        runId: result.attemptId,
        kind: 'rebase',
        actor: 'reaction:merge_conflict',
      })
    } catch (err) {
      if (err instanceof AttemptTerminatedError || err instanceof AttemptNotFoundError) {
        logger.debug(
          { repo: reaction.repo, issueNumber: reaction.issueNumber, runId: run.id },
          'Previous attempt already terminated — skipping merge_conflict reaction',
        )
        return
      }
      throw err
    }
  } else {
    runManager.update(run.id, {
      status: 'queued',
      lastError: null,
      endedAt: null,
      phaseData: {
        ...existingPhaseData,
        reactionContext: reaction.context,
        reactionType: reaction.type,
        reactionSummary: reaction.summary,
      },
    })
  }

  // Transition labels back to ready so the poller picks it up
  try {
    const issue = await forge.getIssue(issueRepo, reaction.issueNumber)
    await transitionLabels(
      forge,
      issueRepo,
      reaction.issueNumber,
      issue.labels,
      'review_ready',
      'queued',
      buildLabelConfig(repoConfig, issue.labels),
    )
  } catch (err) {
    logger.warn(
      { repo: reaction.repo, issueNumber: reaction.issueNumber, err },
      'Failed to transition labels for reaction',
    )
  }

  logger.info(
    { repo: reaction.repo, issueNumber: reaction.issueNumber, type: reaction.type },
    'Reaction handled — issue queued for follow-up',
  )
}
