import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE runs ADD COLUMN operation_intent TEXT NOT NULL DEFAULT 'auto';
    ALTER TABLE runs ADD COLUMN manual_state TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE runs ADD COLUMN control_payload TEXT;
  `)
}
