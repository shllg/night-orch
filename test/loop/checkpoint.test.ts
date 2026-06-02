import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  Checkpoint,
  extractDecisionOutcomes,
  findTerminalDecisionOutcome,
  type CheckpointArtifactEventWriter,
  type PersistedDecisionOutcome,
} from '../../src/loop/checkpoint.js'
import { initDatabase } from '../../src/state/db.js'
import { listHandoffs, recordHandoff } from '../../src/state/handoffs.js'
import type { RunContext } from '../../src/loop/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { createMetricsService } from '../../src/metrics/service.js'

function makeBaseCtx(): RunContext {
  return {
    runId: 'run-test-1',
    repo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: 'Test', body: '', labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: {} as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/1-test',
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
    currentPhase: 'plan',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh' as const,
    blockReason: null,
    prReviewFeedback: null,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
  }
}

describe('Checkpoint', () => {
  let tmpDir: string
  let db: Database.Database
  let checkpoint: Checkpoint

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-checkpoint-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    checkpoint = new Checkpoint(db)

    // Insert a run row for testing
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status) VALUES ('run-test-1', 'org/repo', 1, 'running')",
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('phaseStarted', () => {
    it('updates current_phase in the DB', () => {
      checkpoint.phaseStarted('run-test-1', 'plan')

      const row = db.prepare('SELECT current_phase FROM runs WHERE id = ?').get('run-test-1') as { current_phase: string }
      expect(row.current_phase).toBe('plan')
    })

    it('records a phase_started event', () => {
      checkpoint.phaseStarted('run-test-1', 'plan')

      const event = db
        .prepare('SELECT event_type, phase, data FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1')
        .get('run-test-1') as { event_type: string; phase: string; data: string | null } | undefined

      expect(event?.event_type).toBe('phase_started')
      expect(event?.phase).toBe('plan')
      expect(event?.data).toBeNull()
    })

    it('updates iteration_count when provided', () => {
      checkpoint.phaseStarted('run-test-1', 'plan', 3)

      const row = db.prepare('SELECT iteration_count FROM runs WHERE id = ?').get('run-test-1') as { iteration_count: number | null }
      expect(row.iteration_count).toBe(3)
    })

    it('emits durable artifact event via configured writer', () => {
      const calls: Array<{
        runId: string
        phase: string
        eventType: string
        data: Record<string, unknown> | null
        timestamp: string
      }> = []
      const writer: CheckpointArtifactEventWriter = {
        recordPhaseEvent(event) {
          calls.push(event)
        },
      }
      checkpoint = new Checkpoint(db, writer)

      checkpoint.phaseStarted('run-test-1', 'plan')

      expect(calls).toHaveLength(1)
      expect(calls[0]?.runId).toBe('run-test-1')
      expect(calls[0]?.phase).toBe('plan')
      expect(calls[0]?.eventType).toBe('phase_started')
      expect(calls[0]?.data).toBeNull()
      expect(typeof calls[0]?.timestamp).toBe('string')
    })
  })

  describe('phaseCompleted', () => {
    it('stores phase artifacts in phase_data JSON', () => {
      const plan = { objective: 'Fix login', assumptions: [], filesToChange: [], steps: [], risks: [], testStrategy: '' }
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan })

      const row = db.prepare('SELECT phase_data FROM runs WHERE id = ?').get('run-test-1') as { phase_data: string }
      const data = JSON.parse(row.phase_data)
      expect(data.plan.plan.objective).toBe('Fix login')
    })

    it('records a phase_completed event with artifacts', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'Fix login' } })

      const event = db
        .prepare('SELECT event_type, phase, data FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1')
        .get('run-test-1') as { event_type: string; phase: string; data: string | null } | undefined

      expect(event?.event_type).toBe('phase_completed')
      expect(event?.phase).toBe('plan')
      expect(JSON.parse(event?.data ?? '{}')).toEqual({ plan: { objective: 'Fix login' } })
    })

    it('merges artifacts from multiple phases', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'Fix' } })
      checkpoint.phaseCompleted('run-test-1', 'code', { codeResult: { summary: 'Done' } })

      const row = db.prepare('SELECT phase_data FROM runs WHERE id = ?').get('run-test-1') as { phase_data: string }
      const data = JSON.parse(row.phase_data)
      expect(data.plan).toBeDefined()
      expect(data.code).toBeDefined()
    })

    it('updates iteration_count when provided', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'Fix login' } }, 2)

      const row = db.prepare('SELECT iteration_count FROM runs WHERE id = ?').get('run-test-1') as { iteration_count: number | null }
      expect(row.iteration_count).toBe(2)
    })

    it('records a handoff in the same completion operation', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'Fix login' } }, 1, {
        runId: 'run-test-1',
        attemptId: 'run-test-1',
        stepId: 'plan',
        fromRole: 'planner',
        toRole: 'coder',
        kind: 'plan',
        summary: 'Plan: Fix login',
        contentMd: '## Plan\n\nObjective: Fix login',
        contentJson: { objective: 'Fix login' },
      })

      const phaseRow = db.prepare('SELECT current_phase, phase_data FROM runs WHERE id = ?').get('run-test-1') as {
        current_phase: string
        phase_data: string
      }
      expect(phaseRow.current_phase).toBe('plan')
      expect(JSON.parse(phaseRow.phase_data).plan.plan.objective).toBe('Fix login')

      const handoffs = listHandoffs(db, 'run-test-1')
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0]).toMatchObject({
        runId: 'run-test-1',
        stepId: 'plan',
        kind: 'plan',
        summary: 'Plan: Fix login',
      })
    })
  })

  describe('getLastCompleted', () => {
    it('returns correct phase and artifacts', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { objective: 'Fix login' })

      const last = checkpoint.getLastCompleted('run-test-1')
      expect(last).not.toBeNull()
      expect(last!.phase).toBe('plan')
      expect(last!.artifacts).toEqual({ objective: 'Fix login' })
    })

    it('returns null for run with no phase data', () => {
      const last = checkpoint.getLastCompleted('run-test-1')
      expect(last).toBeNull()
    })

    it('returns null for nonexistent run', () => {
      const last = checkpoint.getLastCompleted('nonexistent')
      expect(last).toBeNull()
    })

    it('returns latest phase after multiple completions', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: 'done' })
      checkpoint.phaseCompleted('run-test-1', 'code', { code: 'done' })

      const last = checkpoint.getLastCompleted('run-test-1')
      expect(last!.phase).toBe('code')
    })
  })

  describe('resumeFromCheckpoint', () => {
    it('reconstructs context with plan from DB', () => {
      const plan = { objective: 'Fix login', assumptions: [], filesToChange: [], steps: [], risks: [], testStrategy: '' }
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan })

      // Set iteration count
      db.prepare('UPDATE runs SET iteration_count = 2, estimated_cost_usd = 1.5 WHERE id = ?').run('run-test-1')

      const baseCtx = makeBaseCtx()
      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', baseCtx)

      expect(resumed).not.toBeNull()
      expect(resumed!.currentPhase).toBe('plan')
      expect(resumed!.plan).toEqual(plan)
      expect(resumed!.iteration).toBe(2)
      expect(resumed!.estimatedCostUsd).toBe(1.5)
    })

    it('rehydrates structured state from handoffs when phase_data is missing', () => {
      const metrics = createMetricsService({ enabled: false, host: '127.0.0.1', port: 9090 })
      const incRecoverySpy = vi.spyOn(metrics, 'incRecoveryFromHandoff')
      checkpoint = new Checkpoint(db, undefined, metrics)
      const plan = {
        objective: 'Fix login',
        assumptions: [],
        filesToChange: ['src/login.ts'],
        steps: [{ order: 1, description: 'Fix guard', files: ['src/login.ts'] }],
        risks: [],
        testStrategy: 'unit tests',
      }
      const reviewResult = {
        verdict: 'CHANGES_REQUIRED' as const,
        summary: 'Needs a null guard',
        findings: [{ severity: 'major' as const, message: 'Missing null guard', suggestedFix: 'Check config first' }],
        definitionOfDoneCheck: {
          issueAddressed: false,
          testsPassing: true,
          noBlockingFindings: false,
        },
      }
      recordHandoff(db, {
        runId: 'run-test-1',
        attemptId: 'run-test-1',
        stepId: 'plan',
        fromRole: 'planner',
        toRole: 'coder',
        kind: 'plan',
        summary: 'Plan: Fix login',
        contentMd: '## Plan',
        contentJson: plan,
      })
      recordHandoff(db, {
        runId: 'run-test-1',
        attemptId: 'run-test-1',
        stepId: 'review',
        fromRole: 'reviewer',
        toRole: 'coder',
        kind: 'review-findings',
        summary: 'Review: CHANGES_REQUIRED',
        contentMd: '## Review Findings',
        contentJson: reviewResult,
      })
      db.prepare('UPDATE runs SET current_phase = ?, phase_data = NULL, iteration_count = ? WHERE id = ?')
        .run('review', 2, 'run-test-1')

      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())

      expect(resumed?.currentPhase).toBe('review')
      expect(resumed?.iteration).toBe(2)
      expect(resumed?.plan).toEqual(plan)
      expect(resumed?.reviewResults).toEqual({ review: reviewResult })
      expect(resumed?.reviewFindings).toEqual([{
        severity: 'major',
        message: 'Missing null guard',
        suggestedFix: 'Check config first',
        sourceStepId: 'review',
        sourceRole: 'reviewer',
      }])

      const event = db
        .prepare('SELECT event_type, phase, data FROM run_log_events WHERE run_id = ? AND event_type = ? ORDER BY id DESC LIMIT 1')
        .get('run-test-1', 'recovery_from_handoff') as { event_type: string; phase: string; data: string } | undefined
      expect(event?.phase).toBe('review')
      expect(JSON.parse(event?.data ?? '{}')).toEqual({
        recoveredKinds: ['plan', 'review-findings'],
      })
      expect(incRecoverySpy).toHaveBeenCalledTimes(1)
    })

    it('returns null for run with no checkpoints', () => {
      const baseCtx = makeBaseCtx()
      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', baseCtx)
      expect(resumed).toBeNull()
    })

    it('returns null for nonexistent run', () => {
      const baseCtx = makeBaseCtx()
      const resumed = checkpoint.resumeFromCheckpoint('nonexistent', baseCtx)
      expect(resumed).toBeNull()
    })

    it('reconstructs context with code result from DB', () => {
      const codeResult = { summary: 'Fixed the bug', changedFiles: ['a.ts'], remainingUncertainty: null, blockers: null }
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'Fix' } })
      checkpoint.phaseCompleted('run-test-1', 'code', { codeResult })

      const baseCtx = makeBaseCtx()
      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', baseCtx)

      expect(resumed!.currentPhase).toBe('code')
      expect(resumed!.codeResult).toEqual(codeResult)
    })

    it('hydrates legacy reviewResult checkpoint data into reviewResults.review', () => {
      const reviewResult = {
        verdict: 'CHANGES_REQUIRED' as const,
        summary: 'Needs tests',
        findings: [{ severity: 'major' as const, message: 'Add unit coverage', suggestedFix: null }],
        definitionOfDoneCheck: { issueAddressed: false, testsPassing: true, noBlockingFindings: false },
      }
      checkpoint.phaseCompleted('run-test-1', 'review', { reviewResult })

      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())

      expect(resumed).not.toBeNull()
      expect(resumed!.reviewResults?.review).toEqual(reviewResult)
      expect(resumed!.reviewFindings).toEqual([
        {
          severity: 'major',
          message: 'Add unit coverage',
          suggestedFix: null,
          sourceStepId: 'review',
          sourceRole: 'reviewer',
        },
      ])
    })

    it('hydrates reviewResults from multiple reviewer phase artifacts', () => {
      const reviewResult = {
        verdict: 'APPROVED' as const,
        summary: 'Main review approved',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
      }
      const crResult = {
        verdict: 'CHANGES_REQUIRED' as const,
        summary: 'CR requested changes',
        findings: [{ severity: 'major' as const, message: 'Harden parser input', suggestedFix: 'Validate input first' }],
        definitionOfDoneCheck: { issueAddressed: false, testsPassing: true, noBlockingFindings: false },
      }
      checkpoint.phaseCompleted('run-test-1', 'review', {
        reviewerKey: 'review',
        reviewResults: { review: reviewResult },
      })
      checkpoint.phaseCompleted('run-test-1', 'cr', {
        reviewerKey: 'cr',
        reviewResults: { cr: crResult },
      })

      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())

      expect(resumed?.reviewResults).toEqual({ review: reviewResult, cr: crResult })
      expect(resumed?.reviewFindings).toEqual([
        {
          severity: 'major',
          message: 'Harden parser input',
          suggestedFix: 'Validate input first',
          sourceStepId: 'cr',
          sourceRole: 'reviewer',
        },
      ])
    })

    it('ignores review phase artifacts whose persisted JSON no longer matches reviewer contracts', () => {
      checkpoint.phaseCompleted('run-test-1', 'review', {
        reviewerKey: 'review',
        reviewResults: {
          review: {
            verdict: 'APPROVED',
            summary: 'missing findings and definition of done',
          },
        },
        reviewResult: {
          verdict: 'CHANGES_REQUIRED',
          summary: 'missing findings and definition of done',
        },
      })

      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())

      expect(resumed).not.toBeNull()
      expect(resumed!.reviewResults).toEqual({})
      expect(resumed!.reviewFindings).toEqual([])
    })

    it('preserves base context fields not in DB', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'Fix' } })

      const baseCtx = makeBaseCtx()
      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', baseCtx)

      expect(resumed!.repo).toBe('org/repo')
      expect(resumed!.issueNumber).toBe(1)
      expect(resumed!.worktreePath).toBe('/tmp/wt')
    })

    it('rehydrates persisted sessionIds so worker --continue chains survive crashes', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'Fix' } })
      checkpoint.persistRunState(
        'run-test-1',
        { planner: 'sess-abc', 'coder::claude': 'sess-def' },
        {},
      )

      const baseCtx = makeBaseCtx()
      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', baseCtx)
      expect(resumed!.sessionIds).toEqual({ planner: 'sess-abc', 'coder::claude': 'sess-def' })
    })

    it('rehydrates persisted stepOutputs so custom-role workflow steps survive crashes', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'Fix' } })
      checkpoint.persistRunState('run-test-1', {}, { 'custom-analysis': { score: 0.87 } })

      const baseCtx = makeBaseCtx()
      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', baseCtx)
      expect(resumed!.stepOutputs).toEqual({ 'custom-analysis': { score: 0.87 } })
    })

    it('rehydrates verification stage metadata from verify artifacts', () => {
      checkpoint.phaseCompleted('run-test-1', 'verify', {
        verifyResults: [{
          command: 'pnpm test',
          exitCode: 1,
          stdout: '',
          stderr: 'failed',
          durationMs: 100,
          passed: false,
          required: false,
          stageId: 'full',
          onFailure: 'warn',
        }],
        diff: 'diff --git a/a b/a',
        diffError: null,
        emptyDiffRetries: 0,
      })

      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())
      expect(resumed?.verifyResults[0]).toMatchObject({
        command: 'pnpm test',
        required: false,
        stageId: 'full',
        onFailure: 'warn',
      })
    })

    it('returns empty defaults when phase_data JSON is corrupt (does not throw)', () => {
      db.prepare('UPDATE runs SET current_phase = ?, phase_data = ? WHERE id = ?').run(
        'plan',
        '{not valid json',
        'run-test-1',
      )

      const baseCtx = makeBaseCtx()
      // Must not throw — corrupt phase_data should degrade gracefully
      expect(() => checkpoint.resumeFromCheckpoint('run-test-1', baseCtx)).not.toThrow()
      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', baseCtx)
      expect(resumed).not.toBeNull()
      expect(resumed!.plan).toBeNull()
    })
  })

  describe('phaseSkipped and phaseBlocked', () => {
    it('phaseSkipped emits paired phase_started + phase_completed events', () => {
      checkpoint.phaseSkipped('run-test-1', 'plan', 1)

      const events = db
        .prepare('SELECT event_type, phase FROM events WHERE run_id = ? ORDER BY id ASC')
        .all('run-test-1') as Array<{ event_type: string; phase: string }>

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ event_type: 'phase_started', phase: 'plan' })
      expect(events[1]).toEqual({ event_type: 'phase_completed', phase: 'plan' })
    })

    it('phaseBlocked records blocked=true in phase_data', () => {
      checkpoint.phaseBlocked('run-test-1', 'plan', 'cost limit exceeded', 1)

      const row = db
        .prepare('SELECT phase_data FROM runs WHERE id = ?')
        .get('run-test-1') as { phase_data: string }
      const data = JSON.parse(row.phase_data)
      expect(data.plan.blocked).toBe(true)
      expect(data.plan.reason).toBe('cost limit exceeded')
    })
  })

  describe('decision outcome persistence', () => {
    it('recordDecisionOutcome + getDecisionOutcomes round-trips', () => {
      checkpoint.recordDecisionOutcome('run-test-1', 'decide', {
        action: 'publish',
        reason: 'ship it',
      })
      const outcomes = checkpoint.getDecisionOutcomes('run-test-1')
      expect(outcomes['decide']).toEqual({ action: 'publish', reason: 'ship it' })
    })

    it('preserves other phase_data alongside decision outcomes', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'Fix' } })
      checkpoint.recordDecisionOutcome('run-test-1', 'decide', { action: 'block', reason: 'budget' })

      const outcomes = checkpoint.getDecisionOutcomes('run-test-1')
      expect(outcomes['decide']?.action).toBe('block')
      // plan data should still be there
      const row = db.prepare('SELECT phase_data FROM runs WHERE id = ?').get('run-test-1') as { phase_data: string }
      const data = JSON.parse(row.phase_data)
      expect(data.plan?.plan?.objective).toBe('Fix')
    })

    it('merges decision outcomes while inside a DB transaction', () => {
      const originalGetPhaseData = checkpoint.getPhaseData.bind(checkpoint)
      let readInsideTransaction = false
      checkpoint.getPhaseData = (runId: string) => {
        readInsideTransaction = db.inTransaction
        return originalGetPhaseData(runId)
      }

      checkpoint.recordDecisionOutcome('run-test-1', 'decide', { action: 'publish' })

      expect(readInsideTransaction).toBe(true)
    })
  })

  describe('run state persistence', () => {
    it('merges session and step output state while inside a DB transaction', () => {
      const originalGetPhaseData = checkpoint.getPhaseData.bind(checkpoint)
      let readInsideTransaction = false
      checkpoint.getPhaseData = (runId: string) => {
        readInsideTransaction = db.inTransaction
        return originalGetPhaseData(runId)
      }

      checkpoint.persistRunState('run-test-1', { planner: 'sess-1' }, { analysis: { score: 1 } })

      expect(readInsideTransaction).toBe(true)
    })
  })

  describe('getCompletedPhases', () => {
    it('lists phase IDs that have completion checkpoints', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'a' } })
      checkpoint.phaseCompleted('run-test-1', 'code', { codeResult: { summary: 'b' } })
      expect(checkpoint.getCompletedPhases('run-test-1')).toEqual(['plan', 'code'])
    })
  })

  describe('findTerminalDecisionOutcome', () => {
    const terminal: PersistedDecisionOutcome = { action: 'publish', reason: 'go' }
    const blockTerminal: PersistedDecisionOutcome = { action: 'block', reason: 'halt', blockReason: 'cost_limit' }
    const errorTerminal: PersistedDecisionOutcome = { action: 'error' }
    const iterate: PersistedDecisionOutcome = { action: 'iterate', reason: 'retry' }

    it('returns publish outcome as terminal', () => {
      const result = findTerminalDecisionOutcome({ decide: terminal })
      expect(result?.phase).toBe('decide')
      expect(result?.outcome.action).toBe('publish')
    })

    it('returns block outcome as terminal', () => {
      expect(findTerminalDecisionOutcome({ decide: blockTerminal })?.outcome.action).toBe('block')
    })

    it('returns error outcome as terminal', () => {
      expect(findTerminalDecisionOutcome({ decide: errorTerminal })?.outcome.action).toBe('error')
    })

    it('does NOT treat iterate as terminal', () => {
      expect(findTerminalDecisionOutcome({ decide: iterate })).toBeNull()
    })

    it('returns null for an empty outcomes map', () => {
      expect(findTerminalDecisionOutcome({})).toBeNull()
    })

    it('returns the first terminal entry when multiple phases exist', () => {
      const result = findTerminalDecisionOutcome({
        'decide-first': iterate,
        'decide-second': terminal,
      })
      expect(result?.phase).toBe('decide-second')
    })
  })

  describe('extractDecisionOutcomes', () => {
    it('returns empty map for null/undefined phase_data', () => {
      expect(extractDecisionOutcomes(null)).toEqual({})
      expect(extractDecisionOutcomes(undefined)).toEqual({})
    })

    it('returns empty map when __decisionOutcomes is absent', () => {
      expect(extractDecisionOutcomes({ plan: { objective: 'x' } })).toEqual({})
    })

    it('returns empty map when __decisionOutcomes is not an object', () => {
      expect(extractDecisionOutcomes({ __decisionOutcomes: 'garbage' })).toEqual({})
      expect(extractDecisionOutcomes({ __decisionOutcomes: [1, 2, 3] })).toEqual({})
    })

    it('returns the decision map when present and well-shaped', () => {
      const outcomes = extractDecisionOutcomes({
        __decisionOutcomes: { decide: { action: 'publish' } },
      })
      expect(outcomes['decide']?.action).toBe('publish')
    })
  })

  describe('R5 — phase_data quarantine', () => {
    function countQuarantine(): number {
      const row = db
        .prepare('SELECT COUNT(*) AS c FROM checkpoint_quarantine WHERE run_id = ?')
        .get('run-test-1') as { c: number }
      return row.c
    }

    function latestQuarantineRow(): {
      phase: string | null
      reason: string
      detail: string
      payload: string | null
    } {
      return db
        .prepare(
          `SELECT phase, reason, detail, payload
           FROM checkpoint_quarantine
           WHERE run_id = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get('run-test-1') as {
        phase: string | null
        reason: string
        detail: string
        payload: string | null
      }
    }

    it('writes a parse_error row and resumes empty on malformed JSON', () => {
      db.prepare(
        `UPDATE runs SET current_phase = 'plan', phase_data = '{"broken":' WHERE id = 'run-test-1'`,
      ).run()

      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())
      expect(resumed).not.toBeNull()
      expect(resumed?.plan).toBeNull()
      expect(resumed?.currentPhase).toBe('plan')

      expect(countQuarantine()).toBe(1)
      const row = latestQuarantineRow()
      expect(row.reason).toBe('parse_error')
      expect(row.phase).toBe('plan')
      expect(row.payload).toBe('{"broken":')
    })

    it('writes a schema_error row when the top level is a JSON array', () => {
      db.prepare(
        `UPDATE runs SET current_phase = 'code', phase_data = '[]' WHERE id = 'run-test-1'`,
      ).run()

      const resumed = checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())
      expect(resumed).not.toBeNull()

      expect(countQuarantine()).toBe(1)
      const row = latestQuarantineRow()
      expect(row.reason).toBe('schema_error')
      expect(row.phase).toBe('code')
      expect(row.detail).toContain('array')
    })

    it('writes a schema_error row when __sessionIds contains a non-string', () => {
      const corrupt = JSON.stringify({ __sessionIds: { planner: 42 } })
      db.prepare(
        `UPDATE runs SET current_phase = 'plan', phase_data = ? WHERE id = 'run-test-1'`,
      ).run(corrupt)

      checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())
      expect(countQuarantine()).toBe(1)
      const row = latestQuarantineRow()
      expect(row.reason).toBe('schema_error')
      expect(row.detail).toContain('__sessionIds')
    })

    it('does not quarantine valid phase_data', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'ok' } })
      checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())
      expect(countQuarantine()).toBe(0)
    })

    it('does not quarantine when phase_data is null (no checkpoint)', () => {
      checkpoint.resumeFromCheckpoint('run-test-1', makeBaseCtx())
      expect(countQuarantine()).toBe(0)
    })
  })
})
