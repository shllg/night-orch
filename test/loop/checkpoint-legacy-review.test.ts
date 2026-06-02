import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { Checkpoint } from '../../src/loop/checkpoint.js'
import { decide } from '../../src/loop/decision.js'
import type { ReviewerOutput, RunContext } from '../../src/loop/types.js'
import type { Config } from '../../src/config/schema.js'

const loopConfig: Config['loop'] = {
  maxReviewIterations: 4,
  maxTotalAgentPasses: 10,
  stopOnPlannerFailure: true,
  requireVerificationPass: true,
  reviewApprovalKeyword: 'APPROVED',
  reviewNeedsChangesKeyword: 'CHANGES_REQUIRED',
  blockOnAmbiguousReview: true,
  maxEmptyDiffRetries: 2,
}

const securityConfig: Config['security'] = {
  maxChangedFiles: 50,
  maxChangedLines: 5000,
  maxDailyCostUsd: 50,
  maxCostPerRunUsd: 10,
}

/**
 * Phase 3 acceptance: a `phase_data` payload written before multi-reviewer
 * support (single `reviewResult` field under the `review` phase, no
 * `reviewResults` map) must still deserialise into the new `reviewResults`
 * map shape on resume, and `decide()` must reach the same verdict it would
 * have reached pre-upgrade.
 *
 * Without this guarantee, an operator who upgrades night-orch while a run is
 * in flight would see review_ready runs blocked or silently re-iterated due
 * to a "missing review" state.
 */
describe('Checkpoint.resumeFromCheckpoint — legacy single reviewer compatibility', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-legacy-review-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    db.prepare(
      `INSERT INTO runs (id, repo, issue_number, status, current_phase, phase_data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-legacy-1',
      'org/repo',
      11,
      'running',
      'review',
      JSON.stringify({
        // Pre-multi-reviewer shape: `reviewResult` under the `review` phase
        // artifacts; no top-level `reviewResults` map exists yet.
        review: { reviewResult: reviewFixture('CHANGES_REQUIRED') },
        completedPhases: ['plan', 'code', 'verify', 'review'],
      }),
    )
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('upgrades legacy reviewResult into reviewResults["review"] on resume', () => {
    const checkpoint = new Checkpoint(db)
    const resumed = checkpoint.resumeFromCheckpoint('run-legacy-1', makeBaseCtx())

    expect(resumed).not.toBeNull()
    expect(resumed!.reviewResults).toEqual({ review: reviewFixture('CHANGES_REQUIRED') })
    // Legacy scalar slot still populated so any code path that reads it
    // pre-migration continues to work.
    expect(resumed!.reviewResult).toEqual(reviewFixture('CHANGES_REQUIRED'))
    // Findings flow into the sourced list with the originating step id so the
    // multi-reviewer aggregation in `decide()` can keep them straight.
    expect(resumed!.reviewFindings.length).toBe(1)
    expect('sourceStepId' in resumed!.reviewFindings[0]! ? resumed!.reviewFindings[0].sourceStepId : null)
      .toBe('review')
  })

  it('decide() reaches CHANGES_REQUIRED verdict on the upgraded context', () => {
    const checkpoint = new Checkpoint(db)
    const resumed = checkpoint.resumeFromCheckpoint('run-legacy-1', makeBaseCtx())
    const decision = decide(resumed!, loopConfig, securityConfig)

    expect(decision.action).toBe('iterate')
  })

  it('publishes when legacy reviewResult was APPROVED with passing verify', () => {
    db.prepare('UPDATE runs SET phase_data = ? WHERE id = ?').run(
      JSON.stringify({
        review: { reviewResult: reviewFixture('APPROVED') },
        verify: {
          verifyResults: [
            { command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 1, passed: true },
          ],
        },
        completedPhases: ['plan', 'code', 'verify', 'review'],
      }),
      'run-legacy-1',
    )

    const checkpoint = new Checkpoint(db)
    const resumed = checkpoint.resumeFromCheckpoint('run-legacy-1', makeBaseCtx())
    expect(resumed!.reviewResults).toEqual({ review: reviewFixture('APPROVED') })
    expect(resumed!.verifyResults.length).toBe(1)

    const decision = decide(resumed!, loopConfig, securityConfig)
    expect(decision.action).toBe('publish')
  })
})

function reviewFixture(verdict: ReviewerOutput['verdict']): ReviewerOutput {
  return {
    verdict,
    summary: 'Needs validation tweak',
    findings: verdict === 'APPROVED'
      ? []
      : [
          {
            severity: 'major',
            category: 'correctness',
            location: 'src/auth.ts:42',
            message: 'Validate the trimmed input length',
            suggestedFix: 'Add 64-char guard',
          },
        ],
    definitionOfDoneCheck: {
      issueAddressed: true,
      testsPassing: verdict === 'APPROVED',
      noBlockingFindings: verdict === 'APPROVED',
    },
  }
}

function makeBaseCtx(): RunContext {
  return {
    runId: 'run-legacy-1',
    repo: 'org/repo',
    issueNumber: 11,
    issue: {
      number: 11,
      nodeId: '',
      title: 'Test',
      body: '',
      labels: [],
      assignees: [],
      state: 'open',
      createdAt: '',
      updatedAt: '',
      url: '',
    },
    repoConfig: {} as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/11-test',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'review',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh',
    blockReason: null,
    prReviewFeedback: null,
    diffError: null,
    emptyDiffRetries: 0,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
  }
}
