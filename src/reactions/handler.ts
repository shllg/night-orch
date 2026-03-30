import type { Reaction } from './types.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { RunManager } from '../state/runs.js'
import type Database from 'better-sqlite3'
import { transitionLabels } from '../labels/manager.js'
import type { buildLabelConfig } from '../labels/config.js'
import { logger } from '../utils/logger.js'

export interface ReactionHandlerDeps {
  db: Database.Database
  forge: ForgeAdapter
  runManager: RunManager
  labelConfig: ReturnType<typeof buildLabelConfig>
}

/**
 * Handle a reaction by transitioning the PR's issue back to queued
 * so the next poll cycle picks it up as a follow-up run.
 *
 * The reaction context is stored in the DB so the follow-up run
 * can include it in the coder's prompt.
 */
export async function handleReaction(
  reaction: Reaction,
  deps: ReactionHandlerDeps,
): Promise<void> {
  const { forge, runManager, labelConfig } = deps

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

  // Store the reaction context on the run so the follow-up iteration can use it
  const existingPhaseData = run.phaseData ?? {}
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

  // Transition labels back to ready so the poller picks it up
  try {
    const issue = await forge.getIssue(reaction.repo, reaction.issueNumber)
    await transitionLabels(
      forge,
      reaction.repo,
      reaction.issueNumber,
      issue.labels,
      'review_ready',
      'queued',
      labelConfig,
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
