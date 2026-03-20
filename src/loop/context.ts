import type { RunContext, LoopPhase, PhaseRecord } from './types.js'

/**
 * Create an updated RunContext with new fields.
 * Returns a new object — original is not mutated.
 */
export function updateContext(ctx: RunContext, patch: Partial<RunContext>): RunContext {
  return { ...ctx, ...patch }
}

/**
 * Record a phase completion in the context's phase history.
 */
export function recordPhase(
  ctx: RunContext,
  phase: LoopPhase,
  result: 'success' | 'failure' | 'skipped',
  artifacts: Record<string, unknown> = {},
): RunContext {
  const record: PhaseRecord = {
    phase,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result,
    artifacts,
  }
  return updateContext(ctx, {
    phaseHistory: [...ctx.phaseHistory, record],
    currentPhase: phase,
  })
}
