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
import { up as migration012 } from './migrations/012-settings-overrides.js'
import { up as migration013 } from './migrations/013-token-usage.js'
import { up as migration014 } from './migrations/014-daily-run-usage.js'
import { up as migration015 } from './migrations/015-run-cost-override.js'
import { up as migration016 } from './migrations/016-daily-cost-cap-override.js'
import { up as migration017 } from './migrations/017-merge-batch-merged-prs.js'
import { up as migration018 } from './migrations/018-run-retry-count.js'
import { up as migration019 } from './migrations/019-runs-active-index-top-level.js'
import { up as migration020 } from './migrations/020-cost-ledger.js'
import { up as migration021 } from './migrations/021-run-control-state.js'
import { up as migration022 } from './migrations/022-run-log-events.js'
import { up as migration023 } from './migrations/023-attempt-columns.js'
import { up as migration024 } from './migrations/024-attempts-head-index.js'
import { up as migration025 } from './migrations/025-cost-token-source.js'
import { up as migration026 } from './migrations/026-checkpoint-quarantine.js'
import { up as migration027 } from './migrations/027-push-subscriptions.js'
import { up as migration028 } from './migrations/028-file-loop.js'
import { up as migration029 } from './migrations/029-cost-theoretical.js'

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
  { version: 12, name: '012-settings-overrides', up: migration012 },
  { version: 13, name: '013-token-usage', up: migration013 },
  { version: 14, name: '014-daily-run-usage', up: migration014 },
  { version: 15, name: '015-run-cost-override', up: migration015 },
  { version: 16, name: '016-daily-cost-cap-override', up: migration016 },
  { version: 17, name: '017-merge-batch-merged-prs', up: migration017 },
  { version: 18, name: '018-run-retry-count', up: migration018 },
  { version: 19, name: '019-runs-active-index-top-level', up: migration019 },
  { version: 20, name: '020-cost-ledger', up: migration020 },
  { version: 21, name: '021-run-control-state', up: migration021 },
  { version: 22, name: '022-run-log-events', up: migration022 },
  { version: 23, name: '023-attempt-columns', up: migration023 },
  { version: 24, name: '024-attempts-head-index', up: migration024 },
  { version: 25, name: '025-cost-token-source', up: migration025 },
  { version: 26, name: '026-checkpoint-quarantine', up: migration026 },
  { version: 27, name: '027-push-subscriptions', up: migration027 },
  { version: 28, name: '028-file-loop', up: migration028 },
  { version: 29, name: '029-cost-theoretical', up: migration029 },
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
