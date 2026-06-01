import type { Checkpoint } from './checkpoint.js'
import { recordPhase, updateContext } from './context.js'
import type { RunContext } from './types.js'

export function blockExit(
  ctx: RunContext,
  checkpoint: Checkpoint,
  phase: string,
  blockReason: NonNullable<RunContext['blockReason']>,
  blockMessage: string,
  stepStartedAt?: string,
): RunContext {
  checkpoint.phaseBlocked(ctx.runId, phase, blockMessage, ctx.iteration)
  return recordPhase(
    updateContext(ctx, {
      currentPhase: 'blocked',
      terminalStatus: 'blocked',
      blockReason,
      stepOutputs: {
        ...ctx.stepOutputs,
        blockMessage,
      },
    }),
    phase,
    'failure',
    {},
    stepStartedAt,
  )
}
