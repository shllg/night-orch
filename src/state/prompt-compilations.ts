import type Database from 'better-sqlite3'
import { getOrInsertContent } from './prompt-contents.js'

export interface RecordPromptCompilationInput {
  runId: string
  stepId: string
  phase: string
  templatePath: string | null
  systemPrompt: string
  userPrompt: string
}

export interface PromptCompilation {
  readonly id: number
  readonly runId: string
  readonly stepId: string
  readonly phase: string
  readonly templatePath: string | null
  readonly templateSha: string
  readonly systemSha: string
  readonly userSha: string
  readonly createdAt: Date
}

interface CompilationRow {
  id: number
  run_id: string
  step_id: string
  phase: string
  template_path: string | null
  template_sha: string
  system_sha: string
  user_sha: string
  created_at: number
}

/**
 * Write a row to `prompt_compilations` capturing the SHA pointers for the
 * three content slices (template body, final system prompt, final user
 * prompt). Each slice is content-addressed via `getOrInsertContent` so the
 * underlying text only persists once across all runs that compiled it.
 */
export function recordPromptCompilation(
  db: Database.Database,
  input: RecordPromptCompilationInput,
): PromptCompilation {
  // The template body itself isn't passed in (the compiler discards it
  // after substitution) so we use the system prompt as the template proxy
  // when no separate body is supplied. This means template_sha == system_sha
  // when the template has no substitutable variables.
  const templateBody = input.templatePath ?? input.systemPrompt
  const templateSha = getOrInsertContent(db, templateBody)
  const systemSha = getOrInsertContent(db, input.systemPrompt)
  const userSha = getOrInsertContent(db, input.userPrompt)
  const createdAt = Date.now()
  const result = db
    .prepare(
      `INSERT INTO prompt_compilations
         (run_id, step_id, phase, template_path, template_sha, system_sha, user_sha, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.stepId,
      input.phase,
      input.templatePath,
      templateSha,
      systemSha,
      userSha,
      createdAt,
    )

  return {
    id: Number(result.lastInsertRowid),
    runId: input.runId,
    stepId: input.stepId,
    phase: input.phase,
    templatePath: input.templatePath,
    templateSha,
    systemSha,
    userSha,
    createdAt: new Date(createdAt),
  }
}

export function listPromptCompilationsByRun(
  db: Database.Database,
  runId: string,
): PromptCompilation[] {
  const rows = db
    .prepare(
      `SELECT id, run_id, step_id, phase, template_path, template_sha, system_sha, user_sha, created_at
       FROM prompt_compilations
       WHERE run_id = ?
       ORDER BY id ASC`,
    )
    .all(runId) as CompilationRow[]
  return rows.map(mapRow)
}

export function listPromptCompilationsByPhase(
  db: Database.Database,
  phase: string,
  sinceMs: number,
): PromptCompilation[] {
  const rows = db
    .prepare(
      `SELECT id, run_id, step_id, phase, template_path, template_sha, system_sha, user_sha, created_at
       FROM prompt_compilations
       WHERE phase = ? AND created_at >= ?
       ORDER BY id ASC`,
    )
    .all(phase, sinceMs) as CompilationRow[]
  return rows.map(mapRow)
}

function mapRow(row: CompilationRow): PromptCompilation {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    phase: row.phase,
    templatePath: row.template_path,
    templateSha: row.template_sha,
    systemSha: row.system_sha,
    userSha: row.user_sha,
    createdAt: new Date(row.created_at),
  }
}
