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
    return { result: null, error: 'No JSON block found in reviewer output' }
  }

  const obj = parsed as Record<string, unknown>
  const verdict = obj['verdict'] as string

  if (!verdict || !VALID_VERDICTS.has(verdict as ReviewVerdict)) {
    return { result: null, error: `Invalid or missing verdict: "${verdict}". Expected: ${[...VALID_VERDICTS].join(', ')}` }
  }

  const validation = ReviewerOutputSchema.safeParse(parsed)
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
