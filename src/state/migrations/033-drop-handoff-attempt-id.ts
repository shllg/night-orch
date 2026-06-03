import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_handoffs_attempt')

  if (hasColumn(db, 'agent_handoffs', 'attempt_id')) {
    db.exec('ALTER TABLE agent_handoffs DROP COLUMN attempt_id')
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
