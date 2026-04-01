import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { logger } from '../utils/logger.js'
import { up as migration001 } from './migrations/001-initial.js'
import { up as migration002 } from './migrations/002-placeholder.js'
import { up as migration003 } from './migrations/003-mention-tracking.js'
import { up as migration004 } from './migrations/004-command-tracking.js'
import { up as migration005 } from './migrations/005-block-reason.js'
import { up as migration006 } from './migrations/006-parent-run.js'
import { up as migration007 } from './migrations/007-merge-queue.js'
import { up as migration008 } from './migrations/008-agent-events.js'
import { up as migration009 } from './migrations/009-run-titles.js'
import { up as migration010 } from './migrations/010-issues.js'
import { up as migration011 } from './migrations/011-rebuild-issues-from-latest-run.js'

const MIGRATIONS = [
  { version: 1, name: '001-initial', up: migration001 },
  { version: 2, name: '002-placeholder', up: migration002 },
  { version: 3, name: '003-mention-tracking', up: migration003 },
  { version: 4, name: '004-command-tracking', up: migration004 },
  { version: 5, name: '005-block-reason', up: migration005 },
  { version: 6, name: '006-parent-run', up: migration006 },
  { version: 7, name: '007-merge-queue', up: migration007 },
  { version: 8, name: '008-agent-events', up: migration008 },
  { version: 9, name: '009-run-titles', up: migration009 },
  { version: 10, name: '010-issues', up: migration010 },
  { version: 11, name: '011-rebuild-issues-from-latest-run', up: migration011 },
]

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)

  // Enable WAL mode for concurrent read access
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')

  // Create migrations tracking table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `).run()

  runMigrations(db)

  logger.debug({ dbPath }, 'Database initialized')
  return db
}

function runMigrations(db: Database.Database): void {
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue

    logger.info({ migration: migration.name }, 'Running migration')

    const runMigration = db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name,
      )
    })

    runMigration()
  }
}
