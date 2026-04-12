import type Database from 'better-sqlite3'

export type RunLogSource = 'system' | 'agent' | 'user'

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
    source: normalizeEventSource(row.source),
    phase: row.phase,
    role: row.role,
    type: row.event_type,
    data: parseEventData(row.data),
    timestamp: row.created_at,
  }))
}

export function loadIssueLogEvents(
  db: Database.Database,
  repo: string,
  issueNumber: number,
  since: number,
  limit: number,
): RunLogEventRecord[] {
  const rows = since > 0
    ? db
      .prepare(
        `SELECT e.id, e.run_id, e.source, e.phase, e.role, e.event_type, e.data, e.created_at
         FROM run_log_events e
         INNER JOIN runs r ON r.id = e.run_id
         WHERE r.repo = ? AND r.issue_number = ? AND e.id > ?
         ORDER BY e.id ASC
         LIMIT ?`,
      )
      .all(repo, issueNumber, since, limit) as RawRunLogEventRow[]
    : db
      .prepare(
        `SELECT e.id, e.run_id, e.source, e.phase, e.role, e.event_type, e.data, e.created_at
         FROM run_log_events e
         INNER JOIN runs r ON r.id = e.run_id
         WHERE r.repo = ? AND r.issue_number = ?
         ORDER BY e.id ASC
         LIMIT ?`,
      )
      .all(repo, issueNumber, limit) as RawRunLogEventRow[]

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    source: normalizeEventSource(row.source),
    phase: row.phase,
    role: row.role,
    type: row.event_type,
    data: parseEventData(row.data),
    timestamp: row.created_at,
  }))
}

export function recordUserAction(
  db: Database.Database,
  params: {
    runId: string
    kind: string
    actor: string
    details?: Record<string, unknown> | null
    timestamp?: string
  },
): void {
  insertRunLogEvent(db, {
    runId: params.runId,
    source: 'user',
    phase: null,
    role: params.actor,
    type: 'user_action',
    data: {
      kind: params.kind,
      actor: params.actor,
      ...(params.details ?? {}),
    },
    timestamp: params.timestamp ?? new Date().toISOString(),
  })
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

function normalizeEventSource(source: string): RunLogSource {
  if (source === 'agent' || source === 'user') {
    return source
  }
  return 'system'
}
