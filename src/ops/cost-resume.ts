import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { CostTracker } from '../loop/cost.js'
import { buildLabelConfig } from '../labels/config.js'
import { transitionLabels } from '../labels/manager.js'
import { LeaseManager } from '../state/leases.js'
import { createFollowupAttempt } from '../state/attempts.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { logger } from '../utils/logger.js'
import { markerTag, upsertBotComment } from '../forge/bot-comment.js'
import { formatStatusComment } from '../forge/status-comment.js'

const STATUS_MARKER = markerTag('status')

/**
 * Scan for cost-blocked runs in a repository and auto-resume them if
 * the budget situation has cleared (new UTC day, cap raised, override
 * granted, or subscription mode).
 *
 * This function queries for runs with status='blocked' AND block_reason='cost_limit',
 * re-evaluates each with CostTracker.checkBudget(), and if overBudget is false,
 * resets the run to queued, zeros out the per-run cost accumulator, releases
 * leases, transitions labels from blocked→queued, and posts a status comment.
 */
export async function scanCostBlockedRuns(
  db: Database.Database,
  config: Config,
  forge: ForgeAdapter,
  repoConfig: Config['repos'][number],
  botUser: string,
): Promise<{ resumed: number; stillBlocked: number }> {
  const costTracker = new CostTracker(db)
  const leaseManager = new LeaseManager(db)
  const labelConfig = buildLabelConfig(repoConfig, [])

  // Find all cost-blocked runs for this repo
  const blockedRuns = db
    .prepare(
      `SELECT id, repo, issue_number, block_reason, estimated_cost_usd, phase_data
       FROM runs
       WHERE repo = ?
         AND status = 'blocked'
         AND block_reason = 'cost_limit'`,
    )
    .all(repoConfig.repo) as Array<{
      id: string
      repo: string
      issue_number: number
      block_reason: string | null
      estimated_cost_usd: number | null
      phase_data: string | null
    }>

  let resumed = 0
  let stillBlocked = 0

  for (const row of blockedRuns) {
    const runId = row.id
    const issueNumber = row.issue_number
    const phaseData = parsePhaseData(row.phase_data)
    const issueRepo = resolveIssueRepo(phaseData, row.repo)

    // Re-evaluate budget for this run
    const budget = costTracker.checkBudget(runId, config.security, config.cost)

    if (budget.overBudget) {
      logger.debug(
        { runId, repo: row.repo, issue: issueNumber, limit: budget.limit },
        'Cost-blocked run still over budget — keeping blocked',
      )
      stillBlocked++
      continue
    }
    // Budget cleared — resume the run
    logger.info(
      { runId, repo: row.repo, issue: issueNumber },
      'Cost budget cleared — auto-resuming blocked run',
    )

    // Atomic transition: finalize the cost-blocked attempt, INSERT a new
    // continue attempt with a fresh cost ledger, release leases.
    //
    // Previously this mutated the same row back to queued and manually
    // zeroed the cost columns, plus called subtractRunCostFromDaily to
    // keep the daily aggregate from re-blocking the same run. Under the
    // attempts model the new row starts at zero cost by construction and
    // the previous row's historical costs stay attributed to it, so the
    // subtract-and-zero dance is gone.
    const transition = db.transaction(() => {
      createFollowupAttempt(db, {
        previousAttemptId: runId,
        intent: 'continue',
        resetBranch: false,
        phaseData,
        controlPayload: {
          source: 'cost_auto_resume',
          issueRepo,
          preserveBranchState: true,
          requestedAt: new Date().toISOString(),
        },
      })

      leaseManager.release(row.repo, issueNumber)
      if (issueRepo !== row.repo) {
        leaseManager.release(issueRepo, issueNumber)
      }
    })
    transition()

    // Transition labels blocked→queued
    try {
      const issue = await forge.getIssue(issueRepo, issueNumber)
      await transitionLabels(
        forge,
        issueRepo,
        issueNumber,
        issue.labels,
        'blocked',
        'queued',
        labelConfig,
      )
    } catch (err) {
      logger.warn(
        { runId, repo: row.repo, issue: issueNumber, err },
        'Failed to transition labels during cost-resume',
      )
    }

    // Post status comment about the resume
    try {
      const body = formatStatusComment({
        nextStep: 'Cost budget cleared — run has been queued for processing.',
      })
      if (botUser) {
        await upsertBotComment(forge, issueRepo, issueNumber, STATUS_MARKER, body, botUser)
      } else {
        await forge.commentOnIssue(
          issueRepo,
          issueNumber,
          '🔄 **night-orch**: Cost budget cleared — run has been queued for processing.',
        )
      }
    } catch (err) {
      logger.warn(
        { runId, repo: row.repo, issue: issueNumber, err },
        'Failed to post cost-resume status comment',
      )
    }

    resumed++
  }

  if (resumed > 0 || stillBlocked > 0) {
    logger.info(
      { repo: repoConfig.repo, resumed, stillBlocked },
      'Cost-blocked run scan complete',
    )
  }

  return { resumed, stillBlocked }
}

function parsePhaseData(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}
