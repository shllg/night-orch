import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      issue_node_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      planner TEXT,
      coder TEXT,
      reviewer TEXT,
      iteration_count INTEGER DEFAULT 0,
      current_phase TEXT,
      phase_data TEXT,
      started_at TEXT,
      ended_at TEXT,
      last_error TEXT,
      pr_number INTEGER,
      branch_name TEXT,
      branch_slug TEXT,
      worktree_path TEXT,
      estimated_cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leases (
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      lease_owner TEXT NOT NULL,
      leased_at TEXT DEFAULT (datetime('now')),
      leased_until TEXT NOT NULL,
      PRIMARY KEY (repo, issue_number)
    );

    CREATE TABLE IF NOT EXISTS issue_links (
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      branch_name TEXT NOT NULL,
      branch_slug TEXT NOT NULL,
      pr_number INTEGER,
      pr_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (repo, issue_number)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      repo TEXT,
      issue_number INTEGER,
      event_type TEXT NOT NULL,
      phase TEXT,
      data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_costs (
      date TEXT PRIMARY KEY,
      total_cost_usd REAL DEFAULT 0,
      run_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_runs_repo_issue ON runs(repo, issue_number);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  `)
}
