import type Database from 'better-sqlite3'
import type { TokenUsage } from '../workers/types.js'

export type HandoffKind =
  | 'plan'
  | 'code-summary'
  | 'review-findings'
  | 'verify-summary'
  | 'external-review-findings'

export interface RecordHandoffInput {
  runId: string
  stepId: string
  fromRole: string | null
  toRole: string | null
  kind: HandoffKind
  summary: string
  contentMd: string
  contentJson?: unknown
  tokenUsage?: TokenUsage
}

export interface AgentHandoff {
  readonly id: number
  readonly runId: string
  readonly stepId: string
  readonly fromRole: string | null
  readonly toRole: string | null
  readonly kind: HandoffKind
  readonly summary: string
  readonly contentMd: string
  readonly contentJson: unknown | null
  readonly tokenUsage: TokenUsage | null
  readonly createdAt: Date
}

interface HandoffRow {
  id: number
  run_id: string
  step_id: string
  from_role: string | null
  to_role: string | null
  kind: HandoffKind
  summary: string
  content_md: string
  content_json: string | null
  token_usage: string | null
  created_at: number
}

export function recordHandoff(db: Database.Database, input: RecordHandoffInput): AgentHandoff {
  const createdAt = Date.now()
  const result = db.prepare(`
    INSERT INTO agent_handoffs (
      run_id,
      step_id,
      from_role,
      to_role,
      kind,
      summary,
      content_md,
      content_json,
      token_usage,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.stepId,
    input.fromRole,
    input.toRole,
    input.kind,
    input.summary,
    input.contentMd,
    input.contentJson === undefined ? null : JSON.stringify(input.contentJson),
    input.tokenUsage === undefined ? null : JSON.stringify(input.tokenUsage),
    createdAt,
  )

  return {
    id: Number(result.lastInsertRowid),
    runId: input.runId,
    stepId: input.stepId,
    fromRole: input.fromRole,
    toRole: input.toRole,
    kind: input.kind,
    summary: input.summary,
    contentMd: input.contentMd,
    contentJson: input.contentJson ?? null,
    tokenUsage: input.tokenUsage ?? null,
    createdAt: new Date(createdAt),
  }
}

export function listHandoffs(db: Database.Database, runId: string): AgentHandoff[] {
  const rows = db.prepare(`
    SELECT id, run_id, step_id, from_role, to_role, kind,
           summary, content_md, content_json, token_usage, created_at
    FROM agent_handoffs
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(runId) as HandoffRow[]

  return rows.map(mapHandoffRow)
}

export function getLatestHandoffByKind(
  db: Database.Database,
  runId: string,
  kind: HandoffKind,
): AgentHandoff | null {
  const row = db.prepare(`
    SELECT id, run_id, step_id, from_role, to_role, kind,
           summary, content_md, content_json, token_usage, created_at
    FROM agent_handoffs
    WHERE run_id = ? AND kind = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(runId, kind) as HandoffRow | undefined

  return row ? mapHandoffRow(row) : null
}

function mapHandoffRow(row: HandoffRow): AgentHandoff {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    fromRole: row.from_role,
    toRole: row.to_role,
    kind: row.kind,
    summary: row.summary,
    contentMd: row.content_md,
    contentJson: parseJsonField(row.content_json),
    tokenUsage: parseJsonField(row.token_usage) as TokenUsage | null,
    createdAt: new Date(row.created_at),
  }
}

function parseJsonField(value: string | null): unknown | null {
  if (value === null) return null
  return JSON.parse(value)
}
