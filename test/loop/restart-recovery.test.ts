import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { Checkpoint } from '../../src/loop/checkpoint.js'
import { recordHandoff } from '../../src/state/handoffs.js'
import {
  renderCodeHandoff,
  renderPlanHandoff,
  renderReviewHandoff,
  renderVerifyHandoff,
} from '../../src/loop/handoff-render.js'
import type {
  CoderOutput,
  PlannerOutput,
  ReviewerOutput,
  RunContext,
  VerifyResult,
} from '../../src/loop/types.js'
import type { MetricsService } from '../../src/metrics/service.js'

/**
 * Restart recovery contract for `Checkpoint.resumeFromCheckpoint`:
 *
 * When `phase_data` is corrupted (NULL, malformed JSON, or otherwise
 * unrecoverable through the normal path), the engine must reconstruct
 * `ctx.plan`, `ctx.codeResult`, `ctx.reviewResults`, and `ctx.verifyResults`
 * from the `agent_handoffs` table and resume the workflow. It must emit a
 * `recovery_from_handoff` event in `run_log_events` and increment the
 * matching metric so the operator can see when the fallback was used.
 *
 * The previous test surface only covered the happy path of `recordHandoff`
 * and the render helpers; this exercises the failure path end-to-end against
 * a real SQLite database so a regression that silently dropped the handoff
 * rehydration branch would surface here.
 */
describe('Checkpoint.resumeFromCheckpoint — restart recovery from handoffs', () => {
  let tmpDir: string
  let db: Database.Database
  let metrics: MetricsService

  const runId = 'run-recover-1'

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-restart-recovery-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    db.prepare(
      `INSERT INTO runs (id, repo, issue_number, status, current_phase)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(runId, 'org/repo', 42, 'running', 'review')

    metrics = makeStubMetrics()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rehydrates plan, codeResult, reviewResults, and verifyResults from handoffs when phase_data is NULL', () => {
    seedHandoffs(db, runId)

    // Force the corruption surface: phase_data is NULL even though phases
    // completed and wrote handoffs. This is what the operator sees after a
    // crash-before-flush or after the quarantine path empties phase_data.
    db.prepare('UPDATE runs SET phase_data = NULL WHERE id = ?').run(runId)

    const checkpoint = new Checkpoint(db, undefined, metrics)
    const baseCtx = makeBaseCtx(runId)

    const resumed = checkpoint.resumeFromCheckpoint(runId, baseCtx)

    expect(resumed).not.toBeNull()
    expect(resumed!.plan).toEqual(planFixture())
    expect(resumed!.codeResult).toEqual(codeFixture())
    expect(resumed!.reviewResults).toEqual({ review: reviewFixture() })
    expect(resumed!.verifyResults).toEqual(verifyFixture())

    // Findings are surfaced with the originating step id so multi-reviewer
    // aggregation downstream still has the source attribution.
    expect(resumed!.reviewFindings.length).toBeGreaterThan(0)
    for (const finding of resumed!.reviewFindings) {
      expect('sourceStepId' in finding ? finding.sourceStepId : null).toBe('review')
    }

    expect(metrics.incRecoveryFromHandoff).toHaveBeenCalledTimes(1)

    const events = readRecoveryEvents(db, runId)
    expect(events.length).toBe(1)
    expect(events[0]!.data).toEqual(
      expect.objectContaining({
        recoveredKinds: expect.arrayContaining(['plan', 'code-summary', 'verify-summary', 'review-findings']),
      }),
    )
  })

  it('also recovers when phase_data is structurally invalid (quarantine path)', () => {
    seedHandoffs(db, runId)

    // Not NULL but garbage — exercises `parsePhaseDataWithQuarantine`, which
    // writes a checkpoint_quarantine row and returns an empty object so the
    // handoff branch becomes the source of truth.
    db.prepare('UPDATE runs SET phase_data = ? WHERE id = ?').run('not-json-at-all', runId)

    const checkpoint = new Checkpoint(db, undefined, metrics)
    const resumed = checkpoint.resumeFromCheckpoint(runId, makeBaseCtx(runId))

    expect(resumed).not.toBeNull()
    expect(resumed!.plan).toEqual(planFixture())
    expect(resumed!.reviewResults).toEqual({ review: reviewFixture() })

    const quarantineRows = db
      .prepare('SELECT COUNT(*) AS n FROM checkpoint_quarantine WHERE run_id = ?')
      .get(runId) as { n: number }
    expect(quarantineRows.n).toBe(1)

    expect(metrics.incRecoveryFromHandoff).toHaveBeenCalled()
  })

  it('does not emit recovery_from_handoff when phase_data is intact', () => {
    seedHandoffs(db, runId)

    // Plausible-looking phase_data with the same plan artifacts already
    // present — no recovery needed, so neither the event nor the metric
    // should fire.
    const phaseData = JSON.stringify({
      plan: { plan: planFixture() },
      code: { codeResult: codeFixture() },
      verify: { verifyResults: verifyFixture() },
      review: { reviewResults: { review: reviewFixture() } },
    })
    db.prepare('UPDATE runs SET phase_data = ? WHERE id = ?').run(phaseData, runId)

    const checkpoint = new Checkpoint(db, undefined, metrics)
    const resumed = checkpoint.resumeFromCheckpoint(runId, makeBaseCtx(runId))

    expect(resumed).not.toBeNull()
    expect(resumed!.plan).toEqual(planFixture())
    expect(metrics.incRecoveryFromHandoff).not.toHaveBeenCalled()
    expect(readRecoveryEvents(db, runId).length).toBe(0)
  })
})

function seedHandoffs(db: Database.Database, runId: string): void {
  const plan = renderPlanHandoff(planFixture())
  recordHandoff(db, {
    runId,
    attemptId: runId,
    stepId: 'plan',
    fromRole: 'planner',
    toRole: 'coder',
    kind: 'plan',
    summary: plan.summary,
    contentMd: plan.contentMd,
    contentJson: plan.contentJson,
  })

  const code = renderCodeHandoff(codeFixture())
  recordHandoff(db, {
    runId,
    attemptId: runId,
    stepId: 'code',
    fromRole: 'coder',
    toRole: 'reviewer',
    kind: 'code-summary',
    summary: code.summary,
    contentMd: code.contentMd,
    contentJson: code.contentJson,
  })

  const verify = renderVerifyHandoff(verifyFixture())
  recordHandoff(db, {
    runId,
    attemptId: runId,
    stepId: 'verify',
    fromRole: null,
    toRole: 'reviewer',
    kind: 'verify-summary',
    summary: verify.summary,
    contentMd: verify.contentMd,
    contentJson: verify.contentJson,
  })

  const review = renderReviewHandoff(reviewFixture(), 'review')
  recordHandoff(db, {
    runId,
    attemptId: runId,
    stepId: 'review',
    fromRole: 'reviewer',
    toRole: 'coder',
    kind: 'review-findings',
    summary: review.summary,
    contentMd: review.contentMd,
    contentJson: review.contentJson,
  })
}

function makeBaseCtx(runId: string): RunContext {
  return {
    runId,
    repo: 'org/repo',
    issueNumber: 42,
    issue: {
      number: 42,
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
    branchName: 'orch/42-test',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResults: {},
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

function planFixture(): PlannerOutput {
  return {
    objective: 'Add greeting endpoint',
    assumptions: ['Express is already wired'],
    filesToChange: ['src/server.ts'],
    steps: [{ order: 1, description: 'Add /hello route', files: ['src/server.ts'] }],
    risks: ['CORS regression'],
    testStrategy: 'integration tests against /hello',
  }
}

function codeFixture(): CoderOutput {
  return {
    summary: 'Added /hello route with tests',
    changedFiles: ['src/server.ts', 'test/server.test.ts'],
    remainingUncertainty: null,
    blockers: null,
  }
}

function reviewFixture(): ReviewerOutput {
  return {
    verdict: 'CHANGES_REQUIRED',
    summary: 'Missing input validation on greeting param',
    findings: [
      {
        severity: 'major',
        category: 'correctness',
        location: 'src/server.ts:24',
        message: 'Validate length of greeting before echoing it',
        suggestedFix: 'Add a 64-char guard before sending response',
      },
    ],
    definitionOfDoneCheck: {
      issueAddressed: true,
      testsPassing: true,
      noBlockingFindings: false,
    },
  }
}

function verifyFixture(): VerifyResult[] {
  return [
    {
      command: 'pnpm test',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1200,
      passed: true,
    },
  ]
}

function readRecoveryEvents(db: Database.Database, runId: string): { data: Record<string, unknown> | null }[] {
  return (db
    .prepare(
      `SELECT data FROM run_log_events
       WHERE run_id = ? AND event_type = 'recovery_from_handoff'`,
    )
    .all(runId) as { data: string | null }[])
    .map((row) => ({ data: row.data ? (JSON.parse(row.data) as Record<string, unknown>) : null }))
}

function makeStubMetrics(): MetricsService {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getRegistry: vi.fn(),
    ready: false,
    endpoint: null,
    incRunsTotal: vi.fn(),
    incAgentInvocations: vi.fn(),
    incLoopIterations: vi.fn(),
    incVerifyRuns: vi.fn(),
    incPROperations: vi.fn(),
    incNotifications: vi.fn(),
    incCostTokenSource: vi.fn(),
    setCheckpointQuarantineRows: vi.fn(),
    incCircuitBreakerTrip: vi.fn(),
    incHandoffs: vi.fn(),
    incRecoveryFromHandoff: vi.fn(),
    incRebaseConflict: vi.fn(),
    incRebaseAutoResolved: vi.fn(),
    incRebaseAutoResolveFailed: vi.fn(),
    incRebaseFanout: vi.fn(),
    incRebaseFanoutSibling: vi.fn(),
    incMentionFeedback: vi.fn(),
    incReviewBotComments: vi.fn(),
    incPostPublishStep: vi.fn(),
    incExternalReviewFindings: vi.fn(),
    observeRunDuration: vi.fn(),
    observePhaseDuration: vi.fn(),
    observeAgentDuration: vi.fn(),
    observeVerifyDuration: vi.fn(),
    setActiveRuns: vi.fn(),
    setDailyCost: vi.fn(),
    setEligibleIssues: vi.fn(),
    addEstimatedCost: vi.fn(),
  } as unknown as MetricsService
}
