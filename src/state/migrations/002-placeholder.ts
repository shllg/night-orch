import type Database from 'better-sqlite3'

/**
 * Reserved migration slot kept for historical continuity.
 * This migration is intentionally a no-op.
 */
export function up(_db: Database.Database): void {
  // no-op
}
