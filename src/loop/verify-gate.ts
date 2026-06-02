import type { Config } from '../config/schema.js'
import type { MetricsService } from '../metrics/service.js'
import { logger } from '../utils/logger.js'
import type { Checkpoint } from './checkpoint.js'
import { recordPhase } from './context.js'
import { handlePostVerifyGuard } from './post-verify-guard.js'
import {
  buildStepArtifacts,
  determineStepSuccess,
  executeVerifyStep,
  type StepDependencies,
} from './step-executor.js'
import { allRequiredVerifyPassed } from './verifier.js'
import type { RunContext } from './types.js'
import type { VerifyStep, WorkflowStep } from './workflow.js'
import { buildStepHandoff } from './handoff.js'

export type VerifyGateResult =
  | { action: 'next'; ctx: RunContext }
  | { action: 'continue'; ctx: RunContext; stepIndex: number }
  | { action: 'return'; ctx: RunContext }

export interface VerifyGateParams {
  ctx: RunContext
  step: VerifyStep
  stepDeps: StepDependencies
  checkpoint: Pick<Checkpoint, 'phaseCompleted' | 'persistRunState' | 'phaseBlocked'>
  steps: WorkflowStep[]
  stepIndex: number
  loopConfig: Config['loop']
  metrics?: MetricsService
  leaseHeartbeat?: () => boolean
  startedAtMs: number
  startedAtIso: string
}

export async function runVerifyGate(params: VerifyGateParams): Promise<VerifyGateResult> {
  const {
    checkpoint,
    leaseHeartbeat,
    loopConfig,
    metrics,
    startedAtIso,
    startedAtMs,
    step,
    stepDeps,
    stepIndex,
    steps,
  } = params

  let { ctx } = params
  const result = await executeVerifyStep(ctx, step, stepDeps)
  ctx = result.ctx
  const stepDurationMs = Date.now() - startedAtMs

  try {
    metrics?.observePhaseDuration('verify', stepDurationMs / 1000)
    metrics?.observeVerifyDuration(stepDurationMs / 1000)
    const allPassed = ctx.verifyResults.length > 0 && allRequiredVerifyPassed(ctx.verifyResults)
    metrics?.incVerifyRuns(allPassed ? 'pass' : 'fail')
  } catch { /* best-effort */ }

  const stepSuccess = determineStepSuccess(step, ctx)
  const artifacts = buildStepArtifacts(step, ctx)
  const handoff = buildStepHandoff({ ctx, step, steps, stepIndex })
  checkpoint.phaseCompleted(ctx.runId, step.id, artifacts, ctx.iteration, handoff ?? undefined)
  if (handoff) {
    try { metrics?.incHandoffs(handoff.kind) } catch { /* best-effort */ }
  }
  checkpoint.persistRunState(ctx.runId, ctx.sessionIds, ctx.stepOutputs)

  if (leaseHeartbeat) {
    const held = leaseHeartbeat()
    if (!held) {
      logger.warn(
        { runId: ctx.runId, phase: step.id },
        'Lease heartbeat failed — lease was released or taken over. Continuing cautiously.',
      )
    }
  }

  ctx = recordPhase(ctx, step.id, stepSuccess ? 'success' : 'failure', {}, startedAtIso)

  const guard = handlePostVerifyGuard({
    ctx,
    checkpoint,
    steps,
    stepIndex,
    loopConfig,
    metrics,
  })

  return guard
}
