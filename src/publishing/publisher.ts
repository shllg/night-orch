import type Database from 'better-sqlite3'
import type { ForgeAdapter } from '../forge/types.js'
import type { RunContext } from '../loop/types.js'
import { buildLabelConfig } from '../labels/config.js'
import { transitionLabels } from '../labels/manager.js'
import { pushBranch } from './push.js'
import { compilePRTitle, compilePRBody } from './pr-body.js'
import { logger } from '../utils/logger.js'

export interface PublishResult {
  prNumber: number
  prUrl: string
  prTitle: string
  created: boolean
}

export interface PublishErrorResult {
  error: string
  phase: 'push' | 'pr'
}

async function transitionToError(
  forge: ForgeAdapter,
  ctx: RunContext,
  errorMessage: string,
): Promise<void> {
  try {
    const issue = await forge.getIssue(ctx.repo, ctx.issueNumber)
    await transitionLabels(
      forge,
      ctx.repo,
      ctx.issueNumber,
      issue.labels,
      'running',
      'error',
      buildLabelConfig(ctx.repoConfig),
    )
  } catch (labelErr) {
    logger.warn({ repo: ctx.repo, issue: ctx.issueNumber, err: labelErr }, 'Failed to transition labels to error during publish failure')
  }

  try {
    await forge.commentOnIssue(ctx.repo, ctx.issueNumber, `Publishing failed: ${errorMessage}`)
  } catch (commentErr) {
    logger.warn({ repo: ctx.repo, issue: ctx.issueNumber, err: commentErr }, 'Failed to comment on issue during publish failure')
  }
}

/**
 * Push branch and create/update PR.
 * On failure, transitions labels to error and notifies via issue comment.
 */
export async function publishPR(
  ctx: RunContext,
  forge: ForgeAdapter,
  db: Database.Database,
): Promise<PublishResult> {
  // 1. Push branch
  try {
    await pushBranch(ctx.worktreePath, ctx.branchName)
  } catch (pushErr) {
    const message = pushErr instanceof Error ? pushErr.message : String(pushErr)
    logger.error({ repo: ctx.repo, branch: ctx.branchName, err: pushErr }, 'Push failed')
    await transitionToError(forge, ctx, `Push failed: ${message}`)
    throw pushErr
  }

  // 2. Look for existing OPEN PR — DB first, then API fallback.
  //    If the linked PR is closed (manually or by branch protection),
  //    clear the stale link and create a new PR instead.
  let existingPrNumber = getLinkedPR(db, ctx.repo, ctx.issueNumber)
  let existingPr = null

  if (existingPrNumber) {
    // Verify the linked PR is still open
    try {
      if (forge.getPR) {
        const linkedPr = await forge.getPR(ctx.repo, existingPrNumber)
        if (linkedPr.state !== 'open') {
          logger.info({ prNumber: existingPrNumber, state: linkedPr.state }, 'Linked PR is no longer open — will create a new one')
          clearLinkedPR(db, ctx.repo, ctx.issueNumber)
          existingPrNumber = null
        } else {
          logger.debug({ prNumber: existingPrNumber }, 'Found linked open PR in DB')
        }
      } else {
        logger.debug({ prNumber: existingPrNumber }, 'Found linked PR in DB (cannot verify state)')
      }
    } catch (checkErr) {
      logger.warn({ prNumber: existingPrNumber, err: checkErr }, 'Failed to verify linked PR state — will try to update anyway')
    }
  }

  if (!existingPrNumber) {
    existingPr = await forge.findPRByBranch(ctx.repo, ctx.branchName)
    if (existingPr) {
      existingPrNumber = existingPr.number
      logger.debug({ prNumber: existingPrNumber }, 'Found existing open PR via API')
    }
  }

  const title = compilePRTitle(ctx.issueNumber, ctx.issue.title, ctx.issue.labels)
  const body = compilePRBody({
    issue: { number: ctx.issueNumber, title: ctx.issue.title, url: ctx.issue.url },
    plan: ctx.plan,
    codeResult: ctx.codeResult,
    verifyResults: ctx.verifyResults,
    reviewResult: ctx.reviewResult,
    roles: ctx.roles,
    iterationCount: ctx.iteration,
    triageLevel: ctx.triageResult.level,
  })

  try {
    if (existingPrNumber) {
      // 3. Update existing open PR
      const updated = await forge.updatePR(ctx.repo, existingPrNumber, { title, body })
      updateLinkedPR(db, ctx.repo, ctx.issueNumber, updated.number, updated.url)
      logger.info({ prNumber: updated.number }, 'Updated existing PR')
      return { prNumber: updated.number, prUrl: updated.url, prTitle: updated.title, created: false }
    }

    // 4. Create new PR (no open PR exists — either first time or old one was closed)
    const pr = await forge.createPR(ctx.repo, {
      title,
      body,
      headBranch: ctx.branchName,
      baseBranch: ctx.repoConfig.baseBranch,
      draft: false,
    })

    updateLinkedPR(db, ctx.repo, ctx.issueNumber, pr.number, pr.url)
    logger.info({ prNumber: pr.number, prUrl: pr.url }, 'Created new PR')
    return { prNumber: pr.number, prUrl: pr.url, prTitle: pr.title, created: true }
  } catch (prErr) {
    const message = prErr instanceof Error ? prErr.message : String(prErr)
    logger.error({ repo: ctx.repo, branch: ctx.branchName, err: prErr }, 'PR creation/update failed')
    await transitionToError(forge, ctx, `PR operation failed: ${message}`)
    throw prErr
  }
}

function getLinkedPR(db: Database.Database, repo: string, issueNumber: number): number | null {
  const row = db
    .prepare('SELECT pr_number FROM issue_links WHERE repo = ? AND issue_number = ? AND pr_number IS NOT NULL')
    .get(repo, issueNumber) as { pr_number: number } | undefined
  return row?.pr_number ?? null
}

function updateLinkedPR(db: Database.Database, repo: string, issueNumber: number, prNumber: number, prUrl: string): void {
  db.prepare(
    'UPDATE issue_links SET pr_number = ?, pr_url = ? WHERE repo = ? AND issue_number = ?',
  ).run(prNumber, prUrl, repo, issueNumber)
}

function clearLinkedPR(db: Database.Database, repo: string, issueNumber: number): void {
  db.prepare(
    'UPDATE issue_links SET pr_number = NULL, pr_url = NULL WHERE repo = ? AND issue_number = ?',
  ).run(repo, issueNumber)
}
