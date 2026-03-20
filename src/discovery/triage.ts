import type { ForgeIssue } from '../forge/types.js'

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

  const fileRefs = issue.body.match(FILE_REFERENCE_PATTERN)
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
        workerTimeoutSeconds: Math.floor(baseTimeout * 0.6),
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
          Math.ceil(baseTimeout * 1.5),
          absoluteMax.timeout,
        ),
      }
    case 'standard':
    default:
      return {
        maxReviewIterations: baseLimits.maxReviewIterations,
        maxTotalAgentPasses: baseLimits.maxTotalAgentPasses,
        workerTimeoutSeconds: baseTimeout,
      }
  }
}
