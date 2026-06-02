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
  attemptId: string
  stepId: string
  fromRole: string | null
  toRole: string | null
  kind: HandoffKind
  summary: string
  contentMd: string
  contentJson?: unknown
  tokenUsage?: TokenUsage
}

export function recordHandoff(db: Database.Database, input: RecordHandoffInput): void {
  db.prepare(`
    INSERT INTO agent_handoffs (
      run_id,
      attempt_id,
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.attemptId,
    input.stepId,
    input.fromRole,
    input.toRole,
    input.kind,
    input.summary,
    input.contentMd,
    input.contentJson === undefined ? null : JSON.stringify(input.contentJson),
    input.tokenUsage === undefined ? null : JSON.stringify(input.tokenUsage),
    Date.now(),
  )
}
