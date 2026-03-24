import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.prepare('ALTER TABLE runs ADD COLUMN block_reason TEXT').run()
}
