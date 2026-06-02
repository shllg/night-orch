import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { getLatestHandoffByKind, listHandoffs, recordHandoff } from '../../src/state/handoffs.js'

describe('agent handoff repository', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-handoffs-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    db.prepare(
      `INSERT INTO runs (id, repo, issue_number, status)
       VALUES (?, ?, ?, ?)`,
    ).run('run-test-1', 'org/repo', 1, 'running')
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records and lists handoffs ordered by insertion with parsed JSON fields', () => {
    const plan = recordHandoff(db, {
      runId: 'run-test-1',
      attemptId: 'run-test-1',
      stepId: 'plan',
      fromRole: 'planner',
      toRole: 'coder',
      kind: 'plan',
      summary: 'Plan: fix retry state',
      contentMd: '## Plan\n\nFix retry state.',
      contentJson: { objective: 'Fix retry state' },
      tokenUsage: { promptTokens: 12, completionTokens: 4, cacheReadTokens: 2 },
    })

    recordHandoff(db, {
      runId: 'run-test-1',
      attemptId: 'run-test-1',
      stepId: 'review',
      fromRole: 'reviewer',
      toRole: 'system',
      kind: 'review-findings',
      summary: 'APPROVED: 0 findings',
      contentMd: '## Review\n\nLooks good.',
      contentJson: { verdict: 'APPROVED', findings: [] },
    })

    expect(plan.id).toBe(1)
    expect(plan.createdAt).toBeInstanceOf(Date)

    const rows = listHandoffs(db, 'run-test-1')
    expect(rows.map((row) => row.stepId)).toEqual(['plan', 'review'])
    expect(rows[0]).toMatchObject({
      runId: 'run-test-1',
      attemptId: 'run-test-1',
      stepId: 'plan',
      fromRole: 'planner',
      toRole: 'coder',
      kind: 'plan',
      summary: 'Plan: fix retry state',
      contentMd: '## Plan\n\nFix retry state.',
      contentJson: { objective: 'Fix retry state' },
      tokenUsage: { promptTokens: 12, completionTokens: 4, cacheReadTokens: 2 },
    })

    expect(getLatestHandoffByKind(db, 'run-test-1', 'review-findings')).toMatchObject({
      stepId: 'review',
      summary: 'APPROVED: 0 findings',
      contentJson: { verdict: 'APPROVED', findings: [] },
      tokenUsage: null,
    })
    expect(getLatestHandoffByKind(db, 'run-test-1', 'verify-summary')).toBeNull()
  })
})
