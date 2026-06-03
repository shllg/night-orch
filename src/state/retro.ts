import type Database from 'better-sqlite3'

export type ClassifierSeverity = 'info' | 'warn' | 'error'

export interface RecordClassifierInput {
  runId: string
  phase: string
  stepId: string | null
  classifier: string
  severity: ClassifierSeverity
  evidence?: Record<string, unknown> | null
}

export interface RetroClassifier {
  readonly id: number
  readonly runId: string
  readonly phase: string
  readonly stepId: string | null
  readonly classifier: string
  readonly severity: ClassifierSeverity
  readonly evidence: Record<string, unknown> | null
  readonly createdAt: Date
}

interface ClassifierRow {
  id: number
  run_id: string
  phase: string
  step_id: string | null
  classifier: string
  severity: ClassifierSeverity
  evidence_json: string | null
  created_at: number
}

export interface RecordSuggestionInput {
  classifier: string
  targetTemplatePath: string
  suggestionMd: string
  sourceRunIds: string[]
}

export interface RetroSuggestion {
  readonly id: number
  readonly generatedAt: Date
  readonly classifier: string
  readonly targetTemplatePath: string
  readonly suggestionMd: string
  readonly sourceRunIds: string[]
  readonly appliedAt: Date | null
  readonly appliedViaCommitSha: string | null
}

interface SuggestionRow {
  id: number
  generated_at: number
  classifier: string
  target_template_path: string
  suggestion_md: string
  source_run_ids_json: string | null
  applied_at: number | null
  applied_via_commit_sha: string | null
}

export function recordClassifier(
  db: Database.Database,
  input: RecordClassifierInput,
): RetroClassifier {
  const createdAt = Date.now()
  const result = db
    .prepare(
      `INSERT INTO retro_classifiers (run_id, phase, step_id, classifier, severity, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.phase,
      input.stepId,
      input.classifier,
      input.severity,
      input.evidence ? JSON.stringify(input.evidence) : null,
      createdAt,
    )

  return {
    id: Number(result.lastInsertRowid),
    runId: input.runId,
    phase: input.phase,
    stepId: input.stepId,
    classifier: input.classifier,
    severity: input.severity,
    evidence: input.evidence ?? null,
    createdAt: new Date(createdAt),
  }
}

export function listClassifiersSince(
  db: Database.Database,
  sinceMs: number,
): RetroClassifier[] {
  const rows = db
    .prepare(
      `SELECT id, run_id, phase, step_id, classifier, severity, evidence_json, created_at
       FROM retro_classifiers
       WHERE created_at >= ? AND phase != 'retro'
       ORDER BY id ASC`,
    )
    .all(sinceMs) as ClassifierRow[]
  return rows.map(mapClassifierRow)
}

export function listClassifiersByRun(
  db: Database.Database,
  runId: string,
): RetroClassifier[] {
  const rows = db
    .prepare(
      `SELECT id, run_id, phase, step_id, classifier, severity, evidence_json, created_at
       FROM retro_classifiers
       WHERE run_id = ?
       ORDER BY id ASC`,
    )
    .all(runId) as ClassifierRow[]
  return rows.map(mapClassifierRow)
}

function mapClassifierRow(row: ClassifierRow): RetroClassifier {
  let evidence: Record<string, unknown> | null = null
  if (row.evidence_json) {
    const parsed = safeJsonParse(row.evidence_json)
    if (parsed && !Array.isArray(parsed)) {
      evidence = parsed
    }
  }
  return {
    id: row.id,
    runId: row.run_id,
    phase: row.phase,
    stepId: row.step_id,
    classifier: row.classifier,
    severity: row.severity,
    evidence,
    createdAt: new Date(row.created_at),
  }
}

export function recordSuggestion(
  db: Database.Database,
  input: RecordSuggestionInput,
): RetroSuggestion {
  const generatedAt = Date.now()
  const result = db
    .prepare(
      `INSERT INTO retro_suggestions
         (generated_at, classifier, target_template_path, suggestion_md, source_run_ids_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      generatedAt,
      input.classifier,
      input.targetTemplatePath,
      input.suggestionMd,
      JSON.stringify(input.sourceRunIds),
    )

  return {
    id: Number(result.lastInsertRowid),
    generatedAt: new Date(generatedAt),
    classifier: input.classifier,
    targetTemplatePath: input.targetTemplatePath,
    suggestionMd: input.suggestionMd,
    sourceRunIds: input.sourceRunIds,
    appliedAt: null,
    appliedViaCommitSha: null,
  }
}

export function listSuggestions(
  db: Database.Database,
  options: { classifier?: string; sinceMs?: number; limit?: number } = {},
): RetroSuggestion[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (options.classifier) {
    where.push('classifier = ?')
    params.push(options.classifier)
  }
  if (options.sinceMs !== undefined) {
    where.push('generated_at >= ?')
    params.push(options.sinceMs)
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limitClause = options.limit !== undefined ? `LIMIT ${Math.max(0, options.limit)}` : ''
  const rows = db
    .prepare(
      `SELECT id, generated_at, classifier, target_template_path, suggestion_md,
              source_run_ids_json, applied_at, applied_via_commit_sha
       FROM retro_suggestions
       ${whereClause}
       ORDER BY generated_at DESC, id DESC
       ${limitClause}`,
    )
    .all(...params) as SuggestionRow[]
  return rows.map(mapSuggestionRow)
}

export function getSuggestion(db: Database.Database, id: number): RetroSuggestion | null {
  const row = db
    .prepare(
      `SELECT id, generated_at, classifier, target_template_path, suggestion_md,
              source_run_ids_json, applied_at, applied_via_commit_sha
       FROM retro_suggestions
       WHERE id = ?`,
    )
    .get(id) as SuggestionRow | undefined
  return row ? mapSuggestionRow(row) : null
}

export function markSuggestionApplied(
  db: Database.Database,
  id: number,
  commitSha?: string,
): void {
  db.prepare(
    `UPDATE retro_suggestions
     SET applied_at = ?, applied_via_commit_sha = ?
     WHERE id = ?`,
  ).run(Date.now(), commitSha ?? null, id)
}

function mapSuggestionRow(row: SuggestionRow): RetroSuggestion {
  return {
    id: row.id,
    generatedAt: new Date(row.generated_at),
    classifier: row.classifier,
    targetTemplatePath: row.target_template_path,
    suggestionMd: row.suggestion_md,
    sourceRunIds: row.source_run_ids_json
      ? (safeJsonParse(row.source_run_ids_json) as string[] | null) ?? []
      : [],
    appliedAt: row.applied_at ? new Date(row.applied_at) : null,
    appliedViaCommitSha: row.applied_via_commit_sha,
  }
}

function safeJsonParse(raw: string): Record<string, unknown> | string[] | null {
  try {
    return JSON.parse(raw) as Record<string, unknown> | string[]
  } catch {
    return null
  }
}
