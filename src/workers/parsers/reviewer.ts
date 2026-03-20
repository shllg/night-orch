import type { ReviewerOutput, ReviewVerdict, ReviewFinding } from '../types.js'
import { parseJsonFromOutput } from './extract.js'

const VALID_VERDICTS = new Set<ReviewVerdict>(['APPROVED', 'CHANGES_REQUIRED', 'BLOCKED'])

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

  return {
    result: {
      verdict: verdict as ReviewVerdict,
      summary: (obj['summary'] as string) ?? '',
      findings: parseFindings(obj['findings']),
      definitionOfDoneCheck: parseDodCheck(obj['definitionOfDoneCheck']),
    },
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
