import type Database from 'better-sqlite3'

interface TableInfoRow {
  name: string
}

export function up(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(runs)').all() as TableInfoRow[]
  const columnNames = new Set(columns.map((column) => column.name))

  if (!columnNames.has('issue_title')) {
    db.prepare('ALTER TABLE runs ADD COLUMN issue_title TEXT').run()
  }
  if (!columnNames.has('pr_title')) {
    db.prepare('ALTER TABLE runs ADD COLUMN pr_title TEXT').run()
  }
}
