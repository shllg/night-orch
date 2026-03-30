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
    return buildTextFallback(raw)
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

/**
 * When the coder produces text with no parseable JSON, construct a
 * synthetic CoderOutput. The engine's git-diff fallback will fill in
 * changedFiles later, but having a non-null result here prevents
 * a hard failure when the coder did real work but skipped the JSON.
 */
function buildTextFallback(raw: string): { result: CoderOutput | null; error: string | null } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { result: null, error: 'No JSON block found in coder output' }
  }

  // Extract a summary from the first meaningful line
  const firstLine = trimmed.split('\n').find((l) => l.trim().length > 0) ?? trimmed
  const summary = firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine

  return {
    result: {
      summary,
      changedFiles: [],
      remainingUncertainty: 'Coder structured output was not parseable — review carefully.',
      blockers: null,
    },
    error: 'No JSON block found — used coder text as fallback',
  }
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val.filter((v): v is string => typeof v === 'string')
}
