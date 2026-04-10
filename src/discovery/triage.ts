import { z } from 'zod'
import type { ForgeIssue } from '../forge/types.js'
import type { AiClient } from '../ai/types.js'
import { isAiError } from '../ai/errors.js'
import { logger } from '../utils/logger.js'

export type TriageLevel = 'trivial' | 'standard' | 'architectural'

export interface TriageResult {
  level: TriageLevel
  reason: string
}

const TRIVIAL_LABELS = new Set(['bug', 'typo', 'chore', 'docs'])
const ARCHITECTURAL_LABELS = new Set(['breaking', 'refactor', 'architecture', 'rfc'])

// Match file-like references: path/to/file.ext or file.ext
const FILE_REFERENCE_PATTERN = /(?:^|\s|[`"'])[\w./\\-]+\.\w{1,10}(?:\s|$|[,;:`"'])/gm

/**
 * Phase 3: optional LLM-backed refinement of the rule-based
 * `triageIssue()` result.
 *
 * When the AI client is available, this function runs the
 * heuristic classifier first (fast, always works) and then asks
 * the LLM to validate or override its decision. The LLM only sees
 * the issue title, body, and labels — no code. On any AI failure
 * (transient, rate limit, schema mismatch) the rule-based result
 * is returned unchanged so triage never blocks on an LLM hiccup.
 *
 * When `ai` is null, behavior is identical to `triageIssue()`.
 *
 * Consumers gate this behind `ai.internal.enable.triage` in
 * config — when the flag is off the poller constructs no AI
 * client and triage stays purely rule-based.
 */
export async function triageIssueWithAi(
  issue: ForgeIssue,
  ai: AiClient | null,
): Promise<TriageResult> {
  const baseline = triageIssue(issue)
  if (!ai) return baseline

  try {
    const prompt = buildTriagePrompt(issue, baseline)
    const result = await ai.completeStructured(
      {
        system:
          'You classify software-engineering issues by complexity. Reply with a JSON object matching the given schema — no prose, no markdown.',
        user: prompt,
        maxTokens: 300,
        timeoutMs: 15_000,
      },
      TriageResponseSchema,
    )
    return {
      level: result.level,
      reason: `LLM: ${result.reason}`,
    }
  } catch (err) {
    if (isAiError(err)) {
      logger.debug(
        { code: err.code, issue: issue.number, err: err.message },
        'LLM triage refinement failed — using rule-based result',
      )
    } else {
      logger.warn(
        { err, issue: issue.number },
        'Unexpected error during LLM triage — using rule-based result',
      )
    }
    return baseline
  }
}

const TriageResponseSchema = z.object({
  level: z.enum(['trivial', 'standard', 'architectural']),
  reason: z.string().min(1).max(200),
})

function buildTriagePrompt(issue: ForgeIssue, baseline: TriageResult): string {
  const labelList = issue.labels.length > 0 ? issue.labels.join(', ') : '(none)'
  // Clamp body to 4k chars — classification doesn't need the full
  // text and longer prompts inflate both latency and token cost.
  const body = issue.body.slice(0, 4_000)
  return [
    `Issue title: ${issue.title}`,
    `Labels: ${labelList}`,
    '',
    `Body (truncated):\n${body}`,
    '',
    `The rule-based heuristic classified this as "${baseline.level}" with reason: ${baseline.reason}.`,
    '',
    'Respond with JSON: {"level": "trivial" | "standard" | "architectural", "reason": "<one sentence explaining the classification>"}.',
    'Guidance:',
    '- "trivial" = single-file typo, dependency bump, tiny doc fix (under 30 minutes of work for a senior engineer)',
    '- "architectural" = touches more than ~5 files, introduces new abstractions, requires design discussion, or has cross-cutting security/performance implications',
    '- "standard" = normal bug fix or feature where the fix location is obvious',
  ].join('\n')
}

/**
 * Classify issue complexity using heuristics (no LLM).
 * - trivial: short body + bug/typo label
 * - architectural: breaking/refactor label or 5+ file references
 * - standard: everything else
 */
export function triageIssue(issue: ForgeIssue): TriageResult {
  const labels = new Set(issue.labels.map((l) => l.toLowerCase()))

  // Check architectural first (takes priority over trivial)
  for (const label of ARCHITECTURAL_LABELS) {
    if (labels.has(label)) {
      return { level: 'architectural', reason: `Label "${label}" indicates architectural change` }
    }
  }

  const bodyWithoutCode = issue.body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '')
  const fileRefs = bodyWithoutCode.match(FILE_REFERENCE_PATTERN)
  if (fileRefs && fileRefs.length >= 5) {
    return {
      level: 'architectural',
      reason: `${fileRefs.length} file references suggest a wide-reaching change`,
    }
  }

  // Check trivial
  const bodyLength = issue.body.trim().length
  const hasTrivialLabel = [...TRIVIAL_LABELS].some((l) => labels.has(l))
  if (hasTrivialLabel && bodyLength < 200) {
    return { level: 'trivial', reason: 'Short body with trivial label' }
  }

  return { level: 'standard', reason: 'Standard issue' }
}

export interface TriageAdjustedLimits {
  maxReviewIterations: number
  maxTotalAgentPasses: number
  workerTimeoutSeconds: number
}

/**
 * Adjust loop/timeout limits based on triage level.
 */
export function adjustLimitsForTriage(
  baseLimits: { maxReviewIterations: number; maxTotalAgentPasses: number },
  baseTimeout: number,
  triage: TriageResult,
  absoluteMax = { iterations: 20, timeout: 7200 },
): TriageAdjustedLimits {
  switch (triage.level) {
    case 'trivial':
      return {
        maxReviewIterations: Math.max(1, Math.floor(baseLimits.maxReviewIterations / 2)),
        maxTotalAgentPasses: Math.max(2, Math.floor(baseLimits.maxTotalAgentPasses / 2)),
        workerTimeoutSeconds: Math.max(1, Math.floor(baseTimeout * 0.6)),
      }
    case 'architectural':
      return {
        maxReviewIterations: Math.min(
          Math.ceil(baseLimits.maxReviewIterations * 1.5),
          absoluteMax.iterations,
        ),
        maxTotalAgentPasses: Math.min(
          Math.ceil(baseLimits.maxTotalAgentPasses * 1.5),
          absoluteMax.iterations,
        ),
        workerTimeoutSeconds: Math.min(
          Math.max(1, Math.ceil(baseTimeout * 1.5)),
          absoluteMax.timeout,
        ),
      }
    case 'standard':
    default:
      return {
        maxReviewIterations: baseLimits.maxReviewIterations,
        maxTotalAgentPasses: baseLimits.maxTotalAgentPasses,
        workerTimeoutSeconds: Math.max(1, baseTimeout),
      }
  }
}
