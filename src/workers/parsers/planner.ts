import type { PlannerOutput } from '../types.js'
import { parseJsonFromOutput } from './extract.js'
import { z } from 'zod'

const StringArraySchema = z.unknown().optional().transform(toStringArray)

const PlannerStepSchema = z.object({
  order: z.number().int().positive().optional(),
  description: z.string().optional().default(''),
  files: StringArraySchema,
}).passthrough()

const PlannerOutputSchema = z.object({
  objective: z.string(),
  assumptions: StringArraySchema,
  filesToChange: StringArraySchema,
  steps: z.unknown().optional().transform(toSteps),
  risks: StringArraySchema,
  testStrategy: z.string().optional().default(''),
}).passthrough()

export function parsePlannerOutput(raw: string): { result: PlannerOutput | null; error: string | null } {
  const parsed = parseJsonFromOutput(raw)
  if (!parsed || typeof parsed !== 'object') {
    return { result: null, error: 'No JSON block found in planner output' }
  }

  const validation = PlannerOutputSchema.safeParse(parsed)
  if (!validation.success) {
    if (validation.error.issues.some((issue) => issue.path[0] === 'objective')) {
      return { result: null, error: 'Planner output missing "objective" field' }
    }
    const firstIssue = validation.error.issues[0]
    const path = firstIssue?.path.join('.') || 'root'
    return { result: null, error: `Planner output failed validation at ${path}` }
  }

  return {
    result: validation.data,
    error: null,
  }
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val.filter((v): v is string => typeof v === 'string')
}

function toSteps(val: unknown): PlannerOutput['steps'] {
  if (!Array.isArray(val)) return []
  return val.map((step, index) => {
    const parsed = PlannerStepSchema.safeParse(step)
    if (!parsed.success) {
      return { order: index + 1, description: '', files: [] }
    }
    return {
      order: parsed.data.order ?? index + 1,
      description: parsed.data.description,
      files: parsed.data.files,
    }
  })
}
