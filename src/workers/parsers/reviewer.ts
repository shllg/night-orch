import type { ReviewerOutput, ReviewVerdict, ReviewFinding } from '../types.js'
import { parseJsonFromOutput } from './extract.js'
import { z } from 'zod'

const VALID_VERDICTS = new Set<ReviewVerdict>(['APPROVED', 'CHANGES_REQUIRED', 'BLOCKED'])

const ReviewerOutputSchema = z.object({
  verdict: z.enum(['APPROVED', 'CHANGES_REQUIRED', 'BLOCKED']),
  summary: z.string().optional().default(''),
  findings: z.unknown().optional().transform(parseFindings),
  definitionOfDoneCheck: z.unknown().optional().transform(parseDodCheck),
}).passthrough()

export function parseReviewerOutput(raw: string): { result: ReviewerOutput | null; error: string | null } {
  const parsed = parseJsonFromOutput(raw)
  if (!parsed || typeof parsed !== 'object') {
    return buildTextFallback(raw)
  }

  const obj = parsed as Record<string, unknown>
  const verdict = obj['verdict'] as string

  if (!verdict || !VALID_VERDICTS.has(verdict as ReviewVerdict)) {
    // Try to infer verdict from text before failing
    const inferredVerdict = inferVerdictFromText(raw)
    if (inferredVerdict) {
      obj['verdict'] = inferredVerdict
    } else {
      return { result: null, error: `Invalid or missing verdict: "${verdict}". Expected: ${[...VALID_VERDICTS].join(', ')}` }
    }
  }

  const validation = ReviewerOutputSchema.safeParse(obj)
  if (!validation.success) {
    const firstIssue = validation.error.issues[0]
    const path = firstIssue?.path.join('.') || 'root'
    return { result: null, error: `Reviewer output failed validation at ${path}` }
  }

  return {
    result: validation.data,
    error: null,
  }
}

/**
 * When the reviewer produces text with no parseable JSON, try to infer
 * a verdict from keywords in the text and construct a synthetic output.
 */
function buildTextFallback(raw: string): { result: ReviewerOutput | null; error: string | null } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { result: null, error: 'No JSON block found in reviewer output' }
  }

  const verdict = inferVerdictFromText(trimmed)
  if (!verdict) {
    return { result: null, error: 'No JSON block found and could not infer verdict from reviewer text' }
  }

  const firstLine = trimmed.split('\n').find((l) => l.trim().length > 0) ?? trimmed
  const summary = firstLine.length > 300 ? firstLine.slice(0, 300) + '...' : firstLine

  return {
    result: {
      verdict,
      summary,
      findings: [],
      definitionOfDoneCheck: {
        issueAddressed: verdict === 'APPROVED',
        testsPassing: verdict === 'APPROVED',
        noBlockingFindings: verdict === 'APPROVED',
      },
    },
    error: `No JSON block found — inferred verdict "${verdict}" from reviewer text`,
  }
}

/**
 * Scan reviewer text for verdict keywords. Case-insensitive matching
 * with word boundaries to avoid false positives.
 */
function inferVerdictFromText(text: string): ReviewVerdict | null {
  const upper = text.toUpperCase()

  // Exact keyword match (strongest signal)
  if (upper.includes('APPROVED') && !upper.includes('NOT APPROVED')) return 'APPROVED'
  if (upper.includes('CHANGES_REQUIRED') || upper.includes('CHANGES REQUIRED')) return 'CHANGES_REQUIRED'
  if (upper.includes('BLOCKED')) return 'BLOCKED'

  // Weaker signals — only use if no ambiguity
  if (/\bLGTM\b/.test(upper) || /\bLOOKS GOOD\b/.test(upper)) return 'APPROVED'
  if (/\bNEEDS? (?:CHANGES?|FIX(?:ES)?|WORK)\b/.test(upper)) return 'CHANGES_REQUIRED'

  return null
}

function parseFindings(val: unknown): ReviewFinding[] {
  if (!Array.isArray(val)) return []
  return val.map((f) => {
    const finding = f as Record<string, unknown>
    return {
      severity: parseSeverity(finding['severity']),
      message: (finding['message'] as string) ?? '',
      suggestedFix: (finding['suggestedFix'] as string) ?? null,
    }
  })
}

function parseSeverity(val: unknown): 'critical' | 'major' | 'minor' {
  if (val === 'critical' || val === 'major' || val === 'minor') return val
  return 'minor'
}

function parseDodCheck(val: unknown): ReviewerOutput['definitionOfDoneCheck'] {
  if (!val || typeof val !== 'object') {
    return { issueAddressed: false, testsPassing: false, noBlockingFindings: false }
  }
  const obj = val as Record<string, unknown>
  return {
    issueAddressed: Boolean(obj['issueAddressed']),
    testsPassing: Boolean(obj['testsPassing']),
    noBlockingFindings: Boolean(obj['noBlockingFindings']),
  }
}
