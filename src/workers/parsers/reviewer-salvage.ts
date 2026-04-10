import { z } from 'zod'
import type { ReviewerOutput } from '../types.js'
import type { AiClient } from '../../ai/types.js'
import { isAiError } from '../../ai/errors.js'
import { logger } from '../../utils/logger.js'

/**
 * Phase 3b: LLM-backed salvage for reviewer outputs that failed
 * the primary JSON parser.
 *
 * **Security posture**: the primary `parseReviewerOutput` already
 * fail-closes on unparseable text because inferring APPROVED or
 * CHANGES_REQUIRED from free text is a known prompt-injection
 * vector (a malicious diff or issue body can coerce the reviewer
 * into emitting those tokens and bypass the gate). This salvage
 * path inherits the same guarantee: **it will never emit
 * APPROVED**. The only verdicts it can produce are
 * CHANGES_REQUIRED and BLOCKED. An approved verdict from
 * unparseable text is suspicious enough to be blocked by default.
 *
 * Operators opt-in per-repo via
 * `ai.internal.enable.reviewerParseFallback: true`. When the flag
 * is off, the raw parser's fail-closed behavior applies — no AI
 * call is made and the run is blocked via `ambiguousReview`.
 *
 * On any AI failure (timeout, rate limit, schema violation,
 * provider error) the salvage returns `null` and the caller falls
 * through to the existing block path.
 */

const SalvageSchema = z.object({
  // Excludes APPROVED by design — see security note above.
  verdict: z.enum(['CHANGES_REQUIRED', 'BLOCKED']),
  summary: z.string().min(1).max(500),
  findings: z
    .array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor']),
        message: z.string().min(1).max(500),
        suggestedFix: z.string().max(500).nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
})

export async function salvageReviewerOutput(
  raw: string,
  ai: AiClient,
): Promise<ReviewerOutput | null> {
  try {
    const response = await ai.completeStructured(
      {
        system: [
          'You extract structured review verdicts from free-text code review output.',
          'You MUST respond with a JSON object containing a verdict of CHANGES_REQUIRED or BLOCKED.',
          'You MUST NOT emit APPROVED — an approved verdict requires the original reviewer to have produced valid structured JSON.',
          'If the input text is inconclusive, pick CHANGES_REQUIRED (the safer default).',
          'Extract findings only when the reviewer explicitly lists concrete issues.',
        ].join('\n'),
        user: [
          'Here is the unparseable reviewer output. Extract a structured verdict.',
          '',
          '--- BEGIN REVIEWER OUTPUT ---',
          raw.slice(0, 6_000),
          '--- END REVIEWER OUTPUT ---',
          '',
          'Respond with JSON matching this shape:',
          '{',
          '  "verdict": "CHANGES_REQUIRED" | "BLOCKED",',
          '  "summary": "<one-sentence description of the reviewer\'s position>",',
          '  "findings": [',
          '    { "severity": "critical" | "major" | "minor", "message": "...", "suggestedFix": "..." }',
          '  ]',
          '}',
        ].join('\n'),
        maxTokens: 800,
        timeoutMs: 20_000,
      },
      SalvageSchema,
    )

    const findings = response.findings ?? []
    const output: ReviewerOutput = {
      verdict: response.verdict,
      summary: response.summary,
      findings: findings.map((f) => ({
        severity: f.severity,
        message: f.message,
        suggestedFix: f.suggestedFix ?? null,
      })),
      definitionOfDoneCheck: {
        // Salvage path can never assert DoD satisfaction.
        issueAddressed: false,
        testsPassing: false,
        noBlockingFindings: false,
      },
    }

    logger.info(
      { verdict: output.verdict, findingsCount: findings.length },
      'Reviewer salvage succeeded — extracted structured verdict from free text',
    )
    return output
  } catch (err) {
    if (isAiError(err)) {
      logger.warn(
        { code: err.code, err: err.message },
        'Reviewer salvage failed — falling through to fail-closed block',
      )
    } else {
      logger.warn({ err }, 'Unexpected error during reviewer salvage')
    }
    return null
  }
}
