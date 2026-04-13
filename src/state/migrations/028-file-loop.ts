import type Database from 'better-sqlite3'

/**
 * File-loop subsystem state.
 *
 * This state intentionally lives outside the issue-centric `runs` / `issues`
 * tables. File-loop sessions are repo-scoped maintenance passes that may run
 * when the issue queue is idle and should not trigger issue-run sync logic.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_loop_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN
        ('armed','running','paused','finalizing','done','failed','cancelled')),
      last_file_iter_at TEXT,
      iterations INTEGER NOT NULL DEFAULT 0,
      files_touched INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      pr_number INTEGER,
      stopped_reason TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_file_loop_sessions_active
      ON file_loop_sessions(repo) WHERE status IN ('armed','running','paused','finalizing');

    CREATE TABLE IF NOT EXISTS file_loop_file_state (
      repo TEXT NOT NULL,
      file_path TEXT NOT NULL,
      last_touched_at TEXT,
      last_status TEXT,
      last_summary_short TEXT,
      last_difficulty_flag TEXT,
      touch_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repo, file_path)
    );

    CREATE INDEX IF NOT EXISTS ix_flfs_pick
      ON file_loop_file_state(repo, last_touched_at);
  `)
}
