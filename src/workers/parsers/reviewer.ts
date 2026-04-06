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
    return { result: null, error: `Invalid or missing verdict: "${verdict}". Expected: ${[...VALID_VERDICTS].join(', ')}` }
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
 * When the reviewer produces text with no parseable JSON, fail closed.
 *
 * Previously this path inferred a verdict from free text (e.g. "LGTM",
 * "APPROVED"), which is a prompt-injection vector: a malicious diff or
 * issue body can coerce the reviewer into emitting those tokens and bypass
 * the gate. We now only ever return BLOCKED on the fallback path (for
 * explicit block signals) or null (for everything else, which callers
 * treat as a reviewer failure and retry/escalate).
 */
function buildTextFallback(raw: string): { result: ReviewerOutput | null; error: string | null } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { result: null, error: 'No JSON block found in reviewer output' }
  }

  const verdict = inferBlockVerdictFromText(trimmed)
  if (!verdict) {
    return { result: null, error: 'No JSON block found in reviewer output' }
  }

  const firstLine = trimmed.split('\n').find((l) => l.trim().length > 0) ?? trimmed
  const summary = firstLine.length > 300 ? firstLine.slice(0, 300) + '...' : firstLine

  return {
    result: {
      verdict,
      summary,
      findings: [],
      definitionOfDoneCheck: {
        issueAddressed: false,
        testsPassing: false,
        noBlockingFindings: false,
      },
    },
    error: `No JSON block found — inferred BLOCKED verdict from reviewer text`,
  }
}

/**
 * Fail-closed text inference: only recognize explicit BLOCKED signals.
 * APPROVED/CHANGES_REQUIRED are intentionally NOT inferred — callers must
 * receive a structured JSON verdict to approve or gate on changes.
 */
function inferBlockVerdictFromText(text: string): ReviewVerdict | null {
  const upper = text.toUpperCase()
  if (upper.includes('BLOCKED')) return 'BLOCKED'
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
