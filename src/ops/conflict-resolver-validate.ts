import type { FullConflictSource } from './conflict-types.js'

export interface ConflictResolutionValidationResult {
  valid: boolean
  reason?: string
}

const CONFLICT_MARKER_PATTERN = /^(<{7}|={7}|>{7})/m

export function validateConflictResolution(
  source: Pick<FullConflictSource, 'mergedWithMarkers' | 'ours' | 'theirs'>,
  resolved: string,
): ConflictResolutionValidationResult {
  if (CONFLICT_MARKER_PATTERN.test(resolved)) {
    return { valid: false, reason: 'resolved output still contains conflict markers' }
  }

  if (resolved.trim().length === 0) {
    return { valid: false, reason: 'resolved output is empty' }
  }

  const oursLength = source.ours.trim().length
  const theirsLength = source.theirs.trim().length
  const resolvedLength = resolved.trim().length
  const minLength = Math.min(oursLength, theirsLength)
  const maxLength = Math.max(oursLength, theirsLength)

  if (minLength > 0 && resolvedLength < Math.floor(minLength * 0.5)) {
    return {
      valid: false,
      reason: `resolved output shrank below the safety floor (${resolvedLength} < ${Math.floor(minLength * 0.5)})`,
    }
  }

  if (maxLength > 0 && resolvedLength > Math.ceil(maxLength * 2)) {
    return {
      valid: false,
      reason: `resolved output grew above the safety ceiling (${resolvedLength} > ${Math.ceil(maxLength * 2)})`,
    }
  }

  const missing = findMissingLines(source, resolved)
  if (missing.length > 0) {
    const sample = missing.slice(0, 3).join(' | ')
    return {
      valid: false,
      reason: `resolved output dropped preserved lines: ${sample}`,
    }
  }

  return { valid: true }
}

function findMissingLines(
  source: Pick<FullConflictSource, 'mergedWithMarkers' | 'ours' | 'theirs'>,
  resolved: string,
): string[] {
  const resolvedLines = new Set(normalizeLines(resolved))
  const requiredLines = new Set(normalizePreservedLines(source.mergedWithMarkers))

  return [...requiredLines].filter((line) => !resolvedLines.has(line))
}

function normalizeLines(value: string): string[] {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
}

function normalizePreservedLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  const preserved: string[] = []
  let inConflict = false

  for (const line of lines) {
    if (line.startsWith('<<<<<<< ')) {
      inConflict = true
      continue
    }
    if (line.startsWith('=======')) {
      continue
    }
    if (line.startsWith('>>>>>>> ')) {
      inConflict = false
      continue
    }
    if (!inConflict) {
      preserved.push(line)
    }
  }

  return normalizeLines(preserved.join('\n'))
}
