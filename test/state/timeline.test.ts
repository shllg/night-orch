import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { recordHandoff } from '../../src/state/handoffs.js'
import { insertRunLogEvent } from '../../src/state/run-log-events.js'
import { buildTimeline, KIND_WEIGHT } from '../../src/state/timeline.js'

const RUN_ID = 'run-timeline-1'

describe('buildTimeline', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-timeline-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status) VALUES (?, 'org/repo', 1, 'running')",
    ).run(RUN_ID)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function insertCost(stepId: string, costUsd: number, createdAt: string): void {
    db.prepare(
      `INSERT INTO run_cost_entries (run_id, step_id, worker_type, cost_usd, prompt_tokens, completion_tokens, cache_read_tokens, created_at)
       VALUES (?, ?, 'claude', ?, 100, 50, 0, ?)`,
    ).run(RUN_ID, stepId, costUsd, createdAt)
  }

  it('returns empty array when run has no entries', () => {
    expect(buildTimeline(db, RUN_ID)).toEqual([])
  })

  it('merges handoffs, events, and cost entries in chronological order', () => {
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'system',
      phase: 'plan',
      role: null,
      type: 'phase_started',
      data: null,
      timestamp: '2026-06-04T10:00:00.000Z',
    })
    // Pin Date.now() so recordHandoff (which uses real time) lands between
    // the two ISO-timestamped fixtures rather than at wall-clock time.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-04T10:01:00.000Z'))
    recordHandoff(db, {
      runId: RUN_ID,
      stepId: 'plan',
      fromRole: 'planner',
      toRole: 'coder',
      kind: 'plan',
      summary: 'Plan summary',
      contentMd: '# plan',
    })
    vi.useRealTimers()
    insertCost('code', 0.12, '2026-06-04T10:02:00.000Z')

    const entries = buildTimeline(db, RUN_ID)
    expect(entries.map((e) => e.kind)).toEqual(['phase', 'handoff', 'cost'])
    // strictly ascending timestamps
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.ts).toBeGreaterThan(entries[i - 1]!.ts)
    }
  })

  it('stable ordering across tables when timestamps collide (kindWeight tiebreak)', () => {
    const ts = '2026-06-04T10:00:00.000Z'
    // Force all three writes to share the exact same epoch ms so kindWeight
    // is the only tiebreak that matters.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(ts))
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'system',
      phase: 'code',
      role: null,
      type: 'phase_completed',
      data: null,
      timestamp: ts,
    })
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'agent',
      phase: 'code',
      role: 'coder',
      type: 'text',
      data: { message: 'thinking' },
      timestamp: ts,
    })
    recordHandoff(db, {
      runId: RUN_ID,
      stepId: 'code',
      fromRole: 'coder',
      toRole: 'reviewer',
      kind: 'code-summary',
      summary: 'Code summary',
      contentMd: '## code',
    })
    vi.useRealTimers()

    const entries = buildTimeline(db, RUN_ID)
    expect(entries).toHaveLength(3)
    // All three share the same ts — order must come from kindWeight ASC:
    //   phase (1) < handoff (2) < event (3)
    expect(entries[0]!.kind).toBe('phase')
    expect(entries[1]!.kind).toBe('handoff')
    expect(entries[2]!.kind).toBe('event')
  })

  it('filters by source', () => {
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'system',
      phase: 'plan',
      role: null,
      type: 'log_a',
      data: null,
      timestamp: '2026-06-04T10:00:00.000Z',
    })
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'agent',
      phase: 'plan',
      role: 'planner',
      type: 'text',
      data: null,
      timestamp: '2026-06-04T10:00:01.000Z',
    })
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'user',
      phase: null,
      role: 'alice',
      type: 'user_action',
      data: null,
      timestamp: '2026-06-04T10:00:02.000Z',
    })

    const onlyAgent = buildTimeline(db, RUN_ID, { sources: ['agent'] })
    expect(onlyAgent).toHaveLength(1)
    expect(onlyAgent[0]!.source).toBe('agent')

    const agentOrUser = buildTimeline(db, RUN_ID, { sources: ['agent', 'user'] })
    expect(agentOrUser).toHaveLength(2)
    expect(agentOrUser.map((e) => e.source)).toEqual(['agent', 'user'])
  })

  it('filters by kind', () => {
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'system',
      phase: 'plan',
      role: null,
      type: 'phase_started',
      data: null,
      timestamp: '2026-06-04T10:00:00.000Z',
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-04T10:00:30.000Z'))
    recordHandoff(db, {
      runId: RUN_ID,
      stepId: 'plan',
      fromRole: 'planner',
      toRole: 'coder',
      kind: 'plan',
      summary: 'plan',
      contentMd: '',
    })
    vi.useRealTimers()
    insertCost('code', 0.05, '2026-06-04T10:01:00.000Z')

    const onlyCost = buildTimeline(db, RUN_ID, { kinds: ['cost'] })
    expect(onlyCost).toHaveLength(1)
    expect(onlyCost[0]!.kind).toBe('cost')

    const phasesAndHandoffs = buildTimeline(db, RUN_ID, { kinds: ['phase', 'handoff'] })
    expect(phasesAndHandoffs.map((e) => e.kind)).toEqual(['phase', 'handoff'])
  })

  it('filters by sinceMs', () => {
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'system',
      phase: 'plan',
      role: null,
      type: 'old',
      data: null,
      timestamp: '2026-06-04T10:00:00.000Z',
    })
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'system',
      phase: 'code',
      role: null,
      type: 'new',
      data: null,
      timestamp: '2026-06-04T11:00:00.000Z',
    })
    const cutoff = Date.parse('2026-06-04T10:30:00.000Z')
    const entries = buildTimeline(db, RUN_ID, { sinceMs: cutoff })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.summary).toContain('new')
  })

  it('respects limit after sort', () => {
    for (let i = 0; i < 5; i++) {
      insertRunLogEvent(db, {
        runId: RUN_ID,
        source: 'system',
        phase: 'plan',
        role: null,
        type: `evt_${i}`,
        data: null,
        timestamp: `2026-06-04T10:00:0${i}.000Z`,
      })
    }
    const entries = buildTimeline(db, RUN_ID, { limit: 3 })
    expect(entries).toHaveLength(3)
    expect(entries.map((e) => e.summary)).toEqual(['evt_0', 'evt_1', 'evt_2'])
  })

  it('does not crash when prompt_compilations does not exist', () => {
    // Migration 034 has not run in this test DB; the optional source
    // should be silently skipped instead of erroring.
    insertRunLogEvent(db, {
      runId: RUN_ID,
      source: 'system',
      phase: 'plan',
      role: null,
      type: 'evt',
      data: null,
      timestamp: '2026-06-04T10:00:00.000Z',
    })
    expect(() => buildTimeline(db, RUN_ID)).not.toThrow()
  })

  it('exposes correct kindWeight constants', () => {
    expect(KIND_WEIGHT.handoff).toBeLessThan(KIND_WEIGHT.event)
    expect(KIND_WEIGHT.event).toBeLessThan(KIND_WEIGHT.cost)
    expect(KIND_WEIGHT.cost).toBeLessThan(KIND_WEIGHT.prompt)
  })
})
