import type { CoderOutput } from '../types.js'
import { parseJsonFromOutput } from './extract.js'
import { z } from 'zod'

const StringArraySchema = z.unknown().optional().transform(toStringArray)

const CoderOutputSchema = z.object({
  summary: z.string().optional().default('No summary provided'),
  changedFiles: StringArraySchema,
  remainingUncertainty: z.string().nullable().optional().transform((value) => typeof value === 'string' ? value : null),
  blockers: z.unknown().nullable().optional().transform((value) => {
    if (value === null || value === undefined) return null
    return toStringArray(value)
  }),
}).passthrough()

export function parseCoderOutput(raw: string): { result: CoderOutput | null; error: string | null } {
  const parsed = parseJsonFromOutput(raw)
  if (!parsed || typeof parsed !== 'object') {
    return { result: null, error: 'No JSON block found in coder output' }
  }

  const validation = CoderOutputSchema.safeParse(parsed)
  if (!validation.success) {
    const firstIssue = validation.error.issues[0]
    const path = firstIssue?.path.join('.') || 'root'
    return { result: null, error: `Coder output failed validation at ${path}` }
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
