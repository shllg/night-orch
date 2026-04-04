import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  if (!hasColumn(db, 'runs', 'prompt_tokens')) {
    db.exec('ALTER TABLE runs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'runs', 'completion_tokens')) {
    db.exec('ALTER TABLE runs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'daily_costs', 'total_prompt_tokens')) {
    db.exec('ALTER TABLE daily_costs ADD COLUMN total_prompt_tokens INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'daily_costs', 'total_completion_tokens')) {
    db.exec('ALTER TABLE daily_costs ADD COLUMN total_completion_tokens INTEGER NOT NULL DEFAULT 0')
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}
