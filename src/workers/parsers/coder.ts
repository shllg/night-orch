import type { CoderOutput } from '../types.js'
import { parseJsonFromOutput } from './extract.js'

export function parseCoderOutput(raw: string): { result: CoderOutput | null; error: string | null } {
  const parsed = parseJsonFromOutput(raw)
  if (!parsed || typeof parsed !== 'object') {
    return { result: null, error: 'No JSON block found in coder output' }
  }

  const obj = parsed as Record<string, unknown>

  return {
    result: {
      summary: (obj['summary'] as string) ?? 'No summary provided',
      changedFiles: asStringArray(obj['changedFiles']),
      remainingUncertainty: (obj['remainingUncertainty'] as string) ?? null,
      blockers: obj['blockers'] ? asStringArray(obj['blockers']) : null,
    },
    error: null,
  }
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val.filter((v): v is string => typeof v === 'string')
}
