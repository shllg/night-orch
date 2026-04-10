import type Database from 'better-sqlite3'

/**
 * R4b: source-tagged provenance on every cost ledger entry.
 *
 * Each row in `run_cost_entries` now carries a `token_source` tag
 * describing where the token counts came from:
 *  - `reported_cli`      → extracted from Claude/Codex/opencode CLI output
 *  - `measured_api`      → returned from a direct-API call (Phase 3 hook)
 *  - `estimated_duration`→ explicit opt-in fallback when the operator
 *                          has flipped `cost.allowEstimatedDuration: true`.
 *                          Rows with this tag are displayed with a
 *                          degraded-confidence warning in reports.
 *  - `fallback_zero`     → reserved for catastrophic parse failures
 *                          when the adapter cannot extract usage AND
 *                          the escape hatch is off. R4a normally
 *                          throws `WorkerTokenCaptureError` before
 *                          reaching the recorder so this tag should
 *                          stay empty; it exists for audit
 *                          completeness.
 *
 * Existing rows are backfilled with `'reported_cli'` because the
 * legacy code path only reached the recorder with worker-reported
 * tokens (the silent duration fallback wrote to the same columns but
 * never distinguished itself). Once R4f telemetry is in place, the
 * non-`reported_cli` counts should stay at zero in the default config.
 */
export function up(db: Database.Database): void {
  if (!hasColumn(db, 'run_cost_entries', 'token_source')) {
    db.exec(
      `ALTER TABLE run_cost_entries ADD COLUMN token_source TEXT NOT NULL DEFAULT 'reported_cli'`,
    )
  }

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_run_cost_entries_token_source
     ON run_cost_entries(token_source)`,
  )
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
