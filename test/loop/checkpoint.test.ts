import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Checkpoint } from '../../src/loop/checkpoint.js'
import { initDatabase } from '../../src/state/db.js'
import type { RunContext } from '../../src/loop/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

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
    reviewResult: null,
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
  })

  describe('getCompletedPhases', () => {
    it('lists phase IDs that have completion checkpoints', () => {
      checkpoint.phaseCompleted('run-test-1', 'plan', { plan: { objective: 'a' } })
      checkpoint.phaseCompleted('run-test-1', 'code', { codeResult: { summary: 'b' } })
      expect(checkpoint.getCompletedPhases('run-test-1')).toEqual(['plan', 'code'])
    })
  })
})
