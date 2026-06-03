import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import {
  recordClassifier,
  listClassifiersSince,
  listClassifiersByRun,
  recordSuggestion,
  listSuggestions,
  getSuggestion,
  markSuggestionApplied,
} from '../../src/state/retro.js'

describe('retro state', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-retro-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    db.prepare(`INSERT INTO runs (id, repo, issue_number, status) VALUES ('r1', 'o/r', 1, 'running')`).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('recordClassifier + listClassifiers*', () => {
    it('round-trips a classifier row', () => {
      const written = recordClassifier(db, {
        runId: 'r1',
        phase: 'code',
        stepId: 'code',
        classifier: 'empty_diff',
        severity: 'warn',
        evidence: { iteration: 2 },
      })
      expect(written.id).toBeGreaterThan(0)

      const all = listClassifiersByRun(db, 'r1')
      expect(all).toHaveLength(1)
      expect(all[0]?.classifier).toBe('empty_diff')
      expect(all[0]?.evidence).toEqual({ iteration: 2 })
    })

    it('listClassifiersSince filters by timestamp', () => {
      recordClassifier(db, { runId: 'r1', phase: 'plan', stepId: null, classifier: 'vague_plan', severity: 'warn' })
      const after = Date.now() + 1000
      const filtered = listClassifiersSince(db, after)
      expect(filtered).toHaveLength(0)
      const before = Date.now() - 1000
      expect(listClassifiersSince(db, before)).toHaveLength(1)
    })

    it("listClassifiersSince excludes phase='retro' (defense-in-depth against recursion)", () => {
      recordClassifier(db, { runId: 'r1', phase: 'retro', stepId: null, classifier: 'cost_blow', severity: 'error' })
      recordClassifier(db, { runId: 'r1', phase: 'code', stepId: null, classifier: 'empty_diff', severity: 'warn' })
      const all = listClassifiersSince(db, 0)
      expect(all.map((c) => c.phase)).toEqual(['code'])
    })

    it('handles missing evidence as null', () => {
      recordClassifier(db, { runId: 'r1', phase: 'code', stepId: null, classifier: 'auth_drift', severity: 'error' })
      const rows = listClassifiersByRun(db, 'r1')
      expect(rows[0]?.evidence).toBeNull()
    })
  })

  describe('recordSuggestion + listSuggestions + apply', () => {
    it('round-trips a suggestion with source run ids', () => {
      const written = recordSuggestion(db, {
        classifier: 'vague_plan',
        targetTemplatePath: 'examples/prompts/full-pipeline/planner-deep.md',
        suggestionMd: '## Suggested edit\nMake the objective explicit.',
        sourceRunIds: ['r1', 'r2', 'r3'],
      })
      expect(written.id).toBeGreaterThan(0)

      const read = getSuggestion(db, written.id)
      expect(read?.sourceRunIds).toEqual(['r1', 'r2', 'r3'])
      expect(read?.appliedAt).toBeNull()
    })

    it('listSuggestions filters by classifier', () => {
      recordSuggestion(db, { classifier: 'a', targetTemplatePath: 't', suggestionMd: 'x', sourceRunIds: [] })
      recordSuggestion(db, { classifier: 'b', targetTemplatePath: 't', suggestionMd: 'y', sourceRunIds: [] })
      const filtered = listSuggestions(db, { classifier: 'a' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0]?.classifier).toBe('a')
    })

    it('listSuggestions sorts newest first', () => {
      const a = recordSuggestion(db, { classifier: 'a', targetTemplatePath: 't', suggestionMd: '1', sourceRunIds: [] })
      const b = recordSuggestion(db, { classifier: 'a', targetTemplatePath: 't', suggestionMd: '2', sourceRunIds: [] })
      const order = listSuggestions(db, {}).map((s) => s.id)
      // newest first; insertion-order ids → b before a
      expect(order[0]).toBe(b.id)
      expect(order[1]).toBe(a.id)
    })

    it('markSuggestionApplied sets applied_at + commit sha', () => {
      const s = recordSuggestion(db, { classifier: 'x', targetTemplatePath: 't', suggestionMd: 'y', sourceRunIds: [] })
      markSuggestionApplied(db, s.id, 'deadbeef')
      const after = getSuggestion(db, s.id)
      expect(after?.appliedAt).not.toBeNull()
      expect(after?.appliedViaCommitSha).toBe('deadbeef')
    })
  })
})
