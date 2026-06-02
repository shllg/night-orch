import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { handleReaction } from '../../src/reactions/handler.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { RepoConfig } from '../../src/config/schema.js'
import type { Reaction } from '../../src/reactions/types.js'

/**
 * Phase 4 acceptance: an `external_review` reaction (synthesised by the
 * post-publish orchestrator when a reviewer returns CHANGES_REQUIRED) must
 * route through the standard `continue`-style follow-up — flipping the
 * existing review_ready run back to `queued` and seeding its phase_data with
 * the rendered findings as `reactionContext` — so the next poll cycle picks
 * up the same code path used for `review_comment` and `ci_failure`.
 *
 * The pre-existing `handler.test.ts` covers the generic non-merge-conflict
 * branch via `ci_failure`; this file adds an external_review-specific case so
 * a regression that special-cased the reaction would surface as a failure
 * here rather than as a silent drop.
 */
describe('handleReaction — external_review (Phase 4 continue feedback path)', () => {
  let tmpDir: string
  let db: Database.Database
  let runs: RunManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-continue-external-review-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    runs = new RunManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('flips the review_ready run back to queued with external review findings on phase_data', async () => {
    const runId = seedReviewReadyRun(runs)
    const forge = makeForge()

    const reaction: Reaction = {
      type: 'external_review',
      repo: 'foo/bar',
      prNumber: 42,
      issueNumber: 7,
      summary: 'External review cr: CHANGES_REQUIRED',
      context: [
        '## External Review Findings',
        '',
        'cr: CHANGES_REQUIRED',
        'Missing null-check before dereferencing `user`',
        '',
        '## Review Findings to Address',
        '- [cr][major] src/auth.ts:42 — Guard against null `user`',
      ].join('\n'),
      detectedAt: '2026-04-13T00:00:00.000Z',
    }

    await handleReaction(reaction, { db, forge, runManager: runs, repoConfig })

    const same = runs.getByRepoAndIssue('foo/bar', 7)
    expect(same!.id).toBe(runId)
    expect(same!.status).toBe('queued')
    expect(same!.phaseData?.reactionType).toBe('external_review')
    expect(same!.phaseData?.reactionSummary).toBe(reaction.summary)
    expect(same!.phaseData?.reactionContext).toBe(reaction.context)

    // Same-run flip, not a new attempt — avoid double-charging the chain
    // length for an automatically synthesised reaction.
    const terminatedAt = db
      .prepare('SELECT terminated_at FROM runs WHERE id = ?')
      .get(runId) as { terminated_at: string | null }
    expect(terminatedAt.terminated_at).toBeNull()

    // Label transition path was invoked (fetches issue + computes diff).
    expect(forge.getIssue).toHaveBeenCalledWith('foo/bar', 7)
  })

  it('skips external_review reactions for runs no longer in review_ready', async () => {
    const row = runs.create({
      repo: 'foo/bar',
      issueNumber: 7,
      issueNodeId: null,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runs.update(row.id, { status: 'blocked' })
    const forge = makeForge()

    await handleReaction(
      {
        type: 'external_review',
        repo: 'foo/bar',
        prNumber: 42,
        issueNumber: 7,
        summary: 'External review cr: BLOCKED',
        context: 'severe finding',
        detectedAt: '2026-04-13T00:00:00.000Z',
      },
      { db, forge, runManager: runs, repoConfig },
    )

    const after = runs.getByRepoAndIssue('foo/bar', 7)
    expect(after!.status).toBe('blocked')
    expect(forge.getIssue).not.toHaveBeenCalled()
  })
})

function seedReviewReadyRun(runs: RunManager): string {
  const row = runs.create({
    repo: 'foo/bar',
    issueNumber: 7,
    issueNodeId: null,
    planner: 'claude',
    coder: 'claude',
    reviewer: 'claude',
  })
  runs.update(row.id, {
    status: 'review_ready',
    branchName: 'feature/x',
    prNumber: 42,
    phaseData: { issueRepo: 'foo/bar' },
  })
  return row.id
}

function makeForge(): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({
      number: 7,
      labels: ['no:review_ready'],
      title: 't',
      body: '',
      state: 'open',
      url: '',
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn(),
    updateComment: vi.fn(),
    listPRReviews: vi.fn().mockResolvedValue([]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    mergePR: vi.fn(),
    closePR: vi.fn(),
  } as unknown as ForgeAdapter
}

const repoConfig = {
  labels: {},
  kanban: undefined,
} as unknown as Pick<RepoConfig, 'labels' | 'kanban'>
