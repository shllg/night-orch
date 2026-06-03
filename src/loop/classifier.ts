import type { BlockReason, PhaseRecord, RunContext, LoopDecision } from './types.js'

const KNOWN_BLOCK_REASONS = new Set<string>([
  'cost_limit',
  'run_token_limit',
  'issue_token_limit',
  'daily_token_limit',
  'iteration_limit',
  'agent_pass_limit',
  'run_wall_clock_limit',
  'stuck_loop',
  'reviewer_blocked',
  'ambiguous_review',
  'verify_config',
  'merge_conflict',
  'auth_failure',
  'empty_diff',
])
import type { ClassifierSeverity } from '../state/retro.js'

/**
 * 17 categories — covering every BlockReason plus three failure modes
 * inferred from worker output shape (context_exhaustion, tool_hallucination,
 * rate_limit_provider) plus three infrastructure failure modes
 * (provider_refusal, dependency_error, upstream_outage).
 */
export type Classifier =
  | 'cost_blow'
  | 'iteration_exhaust'
  | 'time_exhaust'
  | 'stuck_loop'
  | 'review_loop'
  | 'prompt_ambiguity'
  | 'verify_regression'
  | 'git_conflict'
  | 'auth_drift'
  | 'empty_diff'
  | 'vague_plan'
  | 'context_exhaustion'
  | 'tool_hallucination'
  | 'rate_limit_provider'
  | 'provider_refusal'
  | 'dependency_error'
  | 'upstream_outage'

export interface ClassifierResult {
  classifier: Classifier
  severity: ClassifierSeverity
  evidence: Record<string, unknown>
}

const BLOCK_REASON_MAP: Record<BlockReason, Classifier> = {
  cost_limit: 'cost_blow',
  run_token_limit: 'cost_blow',
  issue_token_limit: 'cost_blow',
  daily_token_limit: 'cost_blow',
  iteration_limit: 'iteration_exhaust',
  agent_pass_limit: 'iteration_exhaust',
  run_wall_clock_limit: 'time_exhaust',
  stuck_loop: 'stuck_loop',
  reviewer_blocked: 'review_loop',
  ambiguous_review: 'prompt_ambiguity',
  verify_config: 'verify_regression',
  merge_conflict: 'git_conflict',
  auth_failure: 'auth_drift',
  empty_diff: 'empty_diff',
}

const MIN_PLAN_OBJECTIVE_LENGTH = 24

/**
 * Pure failure classifier. Returns null when the phase does not warrant a
 * classifier row (e.g. successful phase with no anomalies).
 *
 * Reads structural fields on the context — never invokes an LLM.
 */
export function classifyPhaseFailure(
  ctx: RunContext,
  record: PhaseRecord,
  decision?: LoopDecision,
): ClassifierResult | null {
  // Terminal block decision → primary classifier from BlockReason.
  if (decision?.action === 'block') {
    const reason = ctx.blockReason ?? extractBlockReason(decision)
    if (reason) {
      return {
        classifier: BLOCK_REASON_MAP[reason],
        severity: 'error',
        evidence: { phase: record.phase, blockReason: reason },
      }
    }
  }

  if (record.result === 'success') {
    // Structural plan checks even on success — a thin plan is a quality
    // signal worth feeding into retro.
    if (record.phase === 'plan' && ctx.plan) {
      const objective = ctx.plan.objective ?? ''
      const hasAcceptanceCriteria = Boolean(
        ctx.plan.testStrategy && ctx.plan.testStrategy.trim().length > 0,
      )
      if (objective.length < MIN_PLAN_OBJECTIVE_LENGTH || !hasAcceptanceCriteria) {
        return {
          classifier: 'vague_plan',
          severity: 'warn',
          evidence: {
            phase: record.phase,
            objectiveLength: objective.length,
            hasAcceptanceCriteria,
          },
        }
      }
    }
    return null
  }

  // Non-block failures (record.result === 'failure'). Inspect artifacts for
  // worker-output-shape signals.
  const artifacts = record.artifacts ?? {}
  const errorMessage = stringField(artifacts, 'errorMessage')
  const lower = errorMessage?.toLowerCase() ?? ''

  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('rate_limit')) {
    return {
      classifier: 'rate_limit_provider',
      severity: 'warn',
      evidence: { phase: record.phase, errorMessage },
    }
  }
  if (/\b5\d\d\b/.test(lower) || lower.includes('upstream') || lower.includes('bad gateway')) {
    return {
      classifier: 'upstream_outage',
      severity: 'error',
      evidence: { phase: record.phase, errorMessage },
    }
  }
  if (
    lower.includes('content filter') ||
    lower.includes('refused') ||
    lower.includes('safety') ||
    lower.includes('cannot help')
  ) {
    return {
      classifier: 'provider_refusal',
      severity: 'warn',
      evidence: { phase: record.phase, errorMessage },
    }
  }
  if (
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('200000 tokens') ||
    lower.includes('token limit')
  ) {
    return {
      classifier: 'context_exhaustion',
      severity: 'error',
      evidence: { phase: record.phase, errorMessage },
    }
  }
  if (lower.includes('parse') || lower.includes('malformed') || lower.includes('tool call')) {
    return {
      classifier: 'tool_hallucination',
      severity: 'warn',
      evidence: { phase: record.phase, errorMessage },
    }
  }
  if (
    record.phase === 'verify' &&
    (lower.includes('npm') || lower.includes('install') || lower.includes('enoent') || lower.includes('eacces'))
  ) {
    return {
      classifier: 'dependency_error',
      severity: 'error',
      evidence: { phase: record.phase, errorMessage },
    }
  }
  if (record.phase === 'verify') {
    return {
      classifier: 'verify_regression',
      severity: 'warn',
      evidence: { phase: record.phase, errorMessage: errorMessage ?? null },
    }
  }

  // Fall-through: untagged failure. Returning null is intentional — retro
  // surfaces it indirectly via raw run_log_events.
  return null
}

function extractBlockReason(decision: LoopDecision): BlockReason | null {
  if (decision.action !== 'block') return null
  const state = decision.state
  if (!state || typeof state !== 'object') return null
  const reason = (state as { reason?: unknown }).reason
  if (typeof reason === 'string' && KNOWN_BLOCK_REASONS.has(reason)) {
    return reason as BlockReason
  }
  // The new typed BlockedReason union uses `.type` not `.reason`. Surface a
  // best-effort mapping for the common cases the classifier maps directly.
  const typed = (state as { reason?: { type?: unknown } }).reason
  if (typed && typeof typed === 'object') {
    const t = (typed as { type?: unknown }).type
    if (typeof t === 'string') {
      const legacyMap: Record<string, BlockReason> = {
        costLimit: 'cost_limit',
        iterationLimit: 'iteration_limit',
        runTokenLimit: 'run_token_limit',
        issueTokenLimit: 'issue_token_limit',
        dailyTokenLimit: 'daily_token_limit',
        runWallClockLimit: 'run_wall_clock_limit',
        stuckLoop: 'stuck_loop',
        agentPassLimit: 'agent_pass_limit',
        reviewerBlocked: 'reviewer_blocked',
        ambiguousReview: 'ambiguous_review',
        verifyConfig: 'verify_config',
        mergeConflict: 'merge_conflict',
        authFailure: 'auth_failure',
        emptyDiff: 'empty_diff',
      }
      const legacy = legacyMap[t]
      if (legacy) return legacy
    }
  }
  return null
}

function stringField(artifacts: Record<string, unknown>, key: string): string | null {
  const value = artifacts[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
