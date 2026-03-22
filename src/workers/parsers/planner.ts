import type { PlannerOutput } from '../types.js'
import { parseJsonFromOutput } from './extract.js'

export function parsePlannerOutput(raw: string): { result: PlannerOutput | null; error: string | null } {
  const parsed = parseJsonFromOutput(raw)
  if (!parsed || typeof parsed !== 'object') {
    return { result: null, error: 'No JSON block found in planner output' }
  }

  const obj = parsed as Record<string, unknown>

  // Validate minimum required fields
  if (typeof obj['objective'] !== 'string') {
    return { result: null, error: 'Planner output missing "objective" field' }
  }

  return {
    result: {
      objective: obj['objective'],
      assumptions: asStringArray(obj['assumptions']),
      filesToChange: asStringArray(obj['filesToChange']),
      steps: asSteps(obj['steps']),
      risks: asStringArray(obj['risks']),
      testStrategy: (obj['testStrategy'] as string) ?? '',
    },
    error: null,
  }
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val.filter((v): v is string => typeof v === 'string')
}

function asSteps(val: unknown): { order: number; description: string; files: string[] }[] {
  if (!Array.isArray(val)) return []
  return val.map((s, i) => {
    const step = s as Record<string, unknown>
    return {
      order: (step['order'] as number) ?? i + 1,
      description: (step['description'] as string) ?? '',
      files: asStringArray(step['files']),
    }
  })
}
