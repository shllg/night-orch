import type Database from 'better-sqlite3'

/**
 * Self-improvement / retrospective tables (Item 3).
 *
 * Four tables in one migration. The migration runner in `db.ts` already
 * wraps each `up()` call in a transaction, so this function uses plain
 * DDL without an inner BEGIN/COMMIT — better-sqlite3 forbids nested
 * transactions and would throw `cannot start a transaction within a
 * transaction`.
 *
 *   prompt_contents          — content-addressed prompt store (sha PK)
 *   prompt_compilations      — per-compile pointers into prompt_contents
 *   retro_classifiers        — failure tags per phase
 *   retro_suggestions        — meta-agent output (one row per template)
 *
 * Storage rationale: most runs share the same system prompt template, so
 * deduplicating by SHA256 keeps DB growth proportional to the distinct
 * prompt variants used, not the number of compilations. See ADR 0002.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_contents (
      sha TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_compilations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      template_path TEXT,
      template_sha TEXT NOT NULL,
      system_sha TEXT NOT NULL,
      user_sha TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_compilations_run
      ON prompt_compilations(run_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_prompt_compilations_phase
      ON prompt_compilations(phase, created_at);

    CREATE TABLE IF NOT EXISTS retro_classifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      step_id TEXT,
      classifier TEXT NOT NULL,
      severity TEXT NOT NULL,
      evidence_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_retro_classifiers_run
      ON retro_classifiers(run_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_retro_classifiers_classifier
      ON retro_classifiers(classifier, created_at);

    CREATE TABLE IF NOT EXISTS retro_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at INTEGER NOT NULL,
      classifier TEXT NOT NULL,
      target_template_path TEXT NOT NULL,
      suggestion_md TEXT NOT NULL,
      source_run_ids_json TEXT,
      applied_at INTEGER,
      applied_via_commit_sha TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_retro_suggestions_classifier
      ON retro_suggestions(classifier, generated_at);
  `)
}
