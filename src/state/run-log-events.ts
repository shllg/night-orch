import type Database from 'better-sqlite3'

export type RunLogSource = 'system' | 'agent'

export interface RunLogEventRecord {
  id: number
  runId: string
  source: RunLogSource
  phase: string | null
  role: string | null
  type: string
  data: Record<string, unknown> | null
  timestamp: string
}

interface RawRunLogEventRow {
  id: number
  run_id: string
  source: string
  phase: string | null
  role: string | null
  event_type: string
  data: string | null
  created_at: string
}

export function insertRunLogEvent(
  db: Database.Database,
  event: Omit<RunLogEventRecord, 'id'>,
): void {
  db.prepare(
    `INSERT INTO run_log_events (run_id, source, phase, role, event_type, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.runId,
    event.source,
    event.phase,
    event.role,
    event.type,
    event.data ? JSON.stringify(event.data) : null,
    event.timestamp,
  )
}

export function insertRunLogEvents(
  db: Database.Database,
  events: Array<Omit<RunLogEventRecord, 'id'>>,
): void {
  if (events.length === 0) return
  const stmt = db.prepare(
    `INSERT INTO run_log_events (run_id, source, phase, role, event_type, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const event of events) {
    stmt.run(
      event.runId,
      event.source,
      event.phase,
      event.role,
      event.type,
      event.data ? JSON.stringify(event.data) : null,
      event.timestamp,
    )
  }
}

export function loadRunLogEvents(
  db: Database.Database,
  runId: string,
  since: number,
  limit: number,
): RunLogEventRecord[] {
  const rows = since > 0
    ? db
      .prepare(
        `SELECT id, run_id, source, phase, role, event_type, data, created_at
         FROM run_log_events
         WHERE run_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(runId, since, limit) as RawRunLogEventRow[]
    : db
      .prepare(
        `SELECT id, run_id, source, phase, role, event_type, data, created_at
         FROM run_log_events
         WHERE run_id = ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(runId, limit) as RawRunLogEventRow[]

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    source: row.source === 'agent' ? 'agent' : 'system',
    phase: row.phase,
    role: row.role,
    type: row.event_type,
    data: parseEventData(row.data),
    timestamp: row.created_at,
  }))
}

function parseEventData(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}
