import type Database from 'better-sqlite3'
import { nowUtcIso } from '../utils/time.js'

export interface SettingOverrideRow {
  key: string
  value: string
  updatedBy: string | null
  updatedAt: string
}

interface RawSettingOverrideRow {
  key: string
  value: string
  updated_by: string | null
  updated_at: string
}

export class SettingOverrideStore {
  constructor(private db: Database.Database) {}

  list(): SettingOverrideRow[] {
    const rows = this.db
      .prepare(
        `SELECT key, value, updated_by, updated_at
         FROM settings_overrides
         ORDER BY key`,
      )
      .all() as RawSettingOverrideRow[]
    return rows.map(mapSettingOverrideRow)
  }

  get(key: string): SettingOverrideRow | null {
    const row = this.db
      .prepare(
        `SELECT key, value, updated_by, updated_at
         FROM settings_overrides
         WHERE key = ?`,
      )
      .get(key) as RawSettingOverrideRow | undefined
    return row ? mapSettingOverrideRow(row) : null
  }

  upsert(key: string, value: string, updatedBy: string | null): SettingOverrideRow {
    const updatedAt = nowUtcIso()
    this.db
      .prepare(
        `INSERT INTO settings_overrides (key, value, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, updatedBy, updatedAt)

    return this.get(key) ?? {
      key,
      value,
      updatedBy,
      updatedAt,
    }
  }

  delete(key: string): boolean {
    const result = this.db
      .prepare('DELETE FROM settings_overrides WHERE key = ?')
      .run(key)
    return result.changes > 0
  }
}

function mapSettingOverrideRow(row: RawSettingOverrideRow): SettingOverrideRow {
  return {
    key: row.key,
    value: row.value,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}
