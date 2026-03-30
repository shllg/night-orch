import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.prepare('ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id)').run()
}
