import type Database from 'better-sqlite3'

/**
 * R5: quarantine table for corrupt `phase_data` blobs.
 *
 * Before R5, `checkpoint.safeParsePhaseData` silently returned `{}`
 * on any parse failure or non-object payload — so a corrupt row
 * would rehydrate to "no checkpoint" with zero visibility to the
 * operator. R5 switches that path through a zod-validated parser
 * that writes the offending payload to this table before returning
 * empty, giving the operator a place to inspect what failed and
 * why.
 *
 * Columns:
 *  - id         — autoincrement primary key
 *  - run_id     — attempt row id the phase_data came from
 *  - phase      — current_phase value at the time of the failure
 *  - reason     — short classifier: 'parse_error' | 'schema_error'
 *  - detail     — formatted zod issue list or JSON.parse error message
 *  - payload    — raw phase_data string (truncated to 8 KiB for safety)
 *  - created_at — ISO timestamp of the quarantine write
 *
 * Index on (run_id) so the web UI and TUI can surface quarantine
 * entries for a given run without a full table scan.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoint_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      phase TEXT,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoint_quarantine_run
      ON checkpoint_quarantine(run_id);

    CREATE INDEX IF NOT EXISTS idx_checkpoint_quarantine_created
      ON checkpoint_quarantine(created_at);
  `)
}
