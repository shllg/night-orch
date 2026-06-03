import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { up as migration033 } from '../../src/state/migrations/033-drop-handoff-attempt-id.js'

describe('migration 033 agent_handoffs', () => {
  it('drops redundant attempt_id while preserving handoff rows', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY
        );
        INSERT INTO runs (id) VALUES ('run-1');
        CREATE TABLE agent_handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          attempt_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          from_role TEXT,
          to_role TEXT,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          content_md TEXT NOT NULL,
          content_json TEXT,
          token_usage TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_handoffs_attempt ON agent_handoffs(attempt_id, id);
        INSERT INTO agent_handoffs (
          run_id, attempt_id, step_id, from_role, to_role, kind,
          summary, content_md, content_json, token_usage, created_at
        ) VALUES (
          'run-1', 'run-1', 'plan', 'planner', 'coder', 'plan',
          'Plan: Fix', '## Plan', '{"objective":"Fix"}', NULL, 123
        );
      `)

      migration033(db)
      expect(() => migration033(db)).not.toThrow()

      const columns = db
        .prepare('PRAGMA table_info(agent_handoffs)')
        .all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).not.toContain('attempt_id')

      const indexes = db
        .prepare('PRAGMA index_list(agent_handoffs)')
        .all() as Array<{ name: string }>
      expect(indexes.map((index) => index.name)).not.toContain('idx_handoffs_attempt')

      const row = db
        .prepare('SELECT run_id, step_id, kind, summary, content_md, content_json FROM agent_handoffs')
        .get() as {
        run_id: string
        step_id: string
        kind: string
        summary: string
        content_md: string
        content_json: string | null
      }
      expect(row).toEqual({
        run_id: 'run-1',
        step_id: 'plan',
        kind: 'plan',
        summary: 'Plan: Fix',
        content_md: '## Plan',
        content_json: '{"objective":"Fix"}',
      })
    } finally {
      db.close()
    }
  })
})
