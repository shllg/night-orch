import type { RunContext } from './types.js'
import type { Config } from '../config/schema.js'
import type { WorkerAdapter } from '../workers/types.js'
import type { MetricsService } from '../metrics/service.js'
import type { ResolvedWorkflow } from './workflow.js'
import type { PersistedDecisionOutcome } from './checkpoint.js'
import { updateContext, recordPhase } from './context.js'
import { hashVerifyResults, assessProgress } from './progress.js'
import { commitChanges } from './commit.js'
import { executeStep, type StepDependencies } from './step-executor.js'
import { Checkpoint } from './checkpoint.js'
import { CostTracker, describeBudgetBlock, costLimitRecoveryHint, type BudgetStatus } from './cost.js'
import { estimateWorkerCost } from './pricing.js'
import { WorkerAuthError } from '../workers/errors.js'
import { logger } from '../utils/logger.js'
import { utcIsoFromMs } from '../utils/time.js'
import type Database from 'better-sqlite3'
import { buildPlanningPrdPath, isPlanningIssue } from '../planning/mode.js'
import type { AgentEvent } from '../events/types.js'
import type { TokenUsage } from '../workers/types.js'

/** External services injected into the loop engine. Tests can substitute mocks for all of these. */
export interface LoopDependencies {
  db: Database.Database
  config: Config
  adapters: Record<string, WorkerAdapter>
  workflow: ResolvedWorkflow
  envOverrides?: Record<string, string>
  metrics?: MetricsService
  onAgentEvent?: (event: AgentEvent) => void
  onPlanReady?: (ctx: RunContext) => Promise<void>
  /**
   * Called on every phase checkpoint to extend the lease on the issue this
   * run is processing. Optional — tests and sub-loops pass no lease
   * manager. Returning false signals the lease has expired and a concurrent
   * engine may have picked the issue up; the engine logs a warning but
   * does not abort (bailing mid-run has its own race risks).
   */
  leaseHeartbeat?: () => boolean
}

/**
 * Execute the configurable workflow loop.
 * Walks through workflow steps in order, delegating execution to the step executor.
 * Returns the final RunContext with terminal state.
 */
export async function executeLoop(
  initialCtx: RunContext,
  deps: LoopDependencies,
): Promise<RunContext> {
  const { db, config, metrics } = deps
  const checkpoint = new Checkpoint(db)
  const costTracker = new CostTracker(db)

  const resumedCtx = checkpoint.resumeFromCheckpoint(initialCtx.runId, initialCtx)
  let ctx = resumedCtx ?? initialCtx

  const stepDeps: StepDependencies = {
    adapters: deps.adapters,
    config: deps.config,
    envOverrides: deps.envOverrides,
    metrics: deps.metrics,
    onAgentEvent: deps.onAgentEvent,
  }

  const steps = deps.workflow.steps
  const checkpointPhaseData = getCheckpointPhaseData(db, initialCtx.runId)
  const persistedDecisions = checkpoint.getDecisionOutcomes(initialCtx.runId)

  // If a decide step terminated the previous attempt mid-action, replay
  // that terminal outcome instead of re-entering the loop. Without this,
  // a crash between decide-checkpoint and action would silently re-route
  // to iterate and discard the intended terminal state.
  const terminalOutcome = findTerminalDecisionOutcome(persistedDecisions)
  if (terminalOutcome) {
    logger.info(
      { runId: ctx.runId, phase: terminalOutcome.phase, action: terminalOutcome.outcome.action },
      'Resume: replaying persisted terminal decision outcome',
    )
    return applyPersistedDecisionOutcome(ctx, terminalOutcome)
  }

  let stepIndex = resolveStartingStepIndex(steps, resumedCtx, checkpointPhaseData, checkpoint.getCompletedPhases(initialCtx.runId))

  while (stepIndex < steps.length) {
    const step = steps[stepIndex]!

    // Skip step if skipWhen matches triage level. Emit paired
    // phase_started/phase_completed events so the event stream stays
    // well-formed and observability consumers see the skip.
    if ('skipWhen' in step && step.skipWhen === ctx.triageResult.level) {
      checkpoint.phaseSkipped(ctx.runId, step.id, ctx.iteration)
      ctx = recordPhase(ctx, step.id, 'skipped')
      stepIndex++
      continue
    }

    // Cost check before worker steps
    if (step.type === 'worker') {
      const budget = costTracker.checkBudget(ctx.runId, config.security, config.cost)
      if (budget.overBudget) {
        const blockMessage = `${describeBudgetBlock(budget)}. ${costLimitRecoveryHint(budget.limit)}`
        logger.warn(
          {
            runId: ctx.runId,
            limit: budget.limit,
            actualUsd: budget.actualUsd,
            limitUsd: budget.limitUsd,
          },
          'Cost limit exceeded',
        )
        // Emit paired phase_started/phase_completed with a blocked payload
        // so the event stream remains consistent across block early-returns.
        checkpoint.phaseBlocked(ctx.runId, step.id, blockMessage, ctx.iteration)
        return recordPhase(
          updateContext(ctx, {
            currentPhase: 'blocked',
            terminalStatus: 'blocked',
            blockReason: 'cost_limit',
            stepOutputs: {
              ...ctx.stepOutputs,
              blockMessage,
            },
          }),
          step.id,
          'failure',
        )
      }
    }

    // Execute step
    const stepStart = Date.now()
    const stepStartedAt = utcIsoFromMs(stepStart)
    ctx = updateContext(ctx, { currentPhase: step.id })
    checkpoint.phaseStarted(ctx.runId, step.id, ctx.iteration)

    let result: Awaited<ReturnType<typeof executeStep>>
    try {
      result = await executeStep(ctx, step, stepDeps)
    } catch (err) {
      if (err instanceof WorkerAuthError) {
        const blockMessage = `Worker authentication failure (${err.adapterType}). ${err.remediation}`
        logger.error(
          { runId: ctx.runId, phase: step.id, adapterType: err.adapterType },
          blockMessage,
        )
        checkpoint.phaseBlocked(ctx.runId, step.id, blockMessage, ctx.iteration)
        return recordPhase(
          updateContext(ctx, {
            currentPhase: 'blocked',
            terminalStatus: 'blocked',
            blockReason: 'auth_failure',
            stepOutputs: {
              ...ctx.stepOutputs,
              blockMessage,
            },
          }),
          step.id,
          'failure',
          {},
          stepStartedAt,
        )
      }
      throw err
    }
    ctx = result.ctx
    const stepDurationMs = Date.now() - stepStart

    // Cost tracking for worker steps
    if (step.type === 'worker') {
      const costResult = applyEstimatedWorkerCost(
        ctx,
        costTracker,
        config.cost,
        config.security,
        step.id,
        step.role,
        result.pricingIdentity,
        stepDurationMs,
        result.tokenUsage,
      )
      ctx = costResult.ctx
      if (costResult.budget?.overBudget) {
        const blockMessage = `${describeBudgetBlock(costResult.budget)}. ${costLimitRecoveryHint(costResult.budget.limit)}`
        logger.warn(
          {
            runId: ctx.runId,
            phase: step.id,
            limit: costResult.budget.limit,
            actualUsd: costResult.budget.actualUsd,
            limitUsd: costResult.budget.limitUsd,
          },
          'Cost limit exceeded after recording worker cost',
        )
        checkpoint.phaseBlocked(ctx.runId, step.id, blockMessage, ctx.iteration)
        return recordPhase(
          updateContext(ctx, {
            currentPhase: 'blocked',
            terminalStatus: 'blocked',
            blockReason: 'cost_limit',
            stepOutputs: {
              ...ctx.stepOutputs,
              blockMessage,
            },
          }),
          step.id,
          'failure',
          {},
          stepStartedAt,
        )
      }
      try { metrics?.observePhaseDuration(step.id, stepDurationMs / 1000) } catch { /* best-effort */ }
    }
    if (step.type === 'verify') {
      try {
        metrics?.observePhaseDuration('verify', stepDurationMs / 1000)
        metrics?.observeVerifyDuration(stepDurationMs / 1000)
        const allPassed = ctx.verifyResults.length > 0 && ctx.verifyResults.every(r => r.passed)
        metrics?.incVerifyRuns(allPassed ? 'pass' : 'fail')
      } catch { /* best-effort */ }
    }

    // Determine step success
    const stepSuccess = determineStepSuccess(step, ctx)

    // stopOnPlannerFailure check
    if (step.type === 'worker' && step.role === 'planner' && !stepSuccess && config.loop.stopOnPlannerFailure) {
      logger.error({ runId: ctx.runId }, 'Planner failed and stopOnPlannerFailure is true')
      const artifacts = buildStepArtifacts(step, ctx)
      checkpoint.phaseCompleted(ctx.runId, step.id, artifacts, ctx.iteration)
      return recordPhase(
        updateContext(ctx, { currentPhase: 'error', terminalStatus: 'error' }),
        step.id,
        'failure',
        {},
        stepStartedAt,
      )
    }

    // Checkpoint and record
    const artifacts = buildStepArtifacts(step, ctx)
    checkpoint.phaseCompleted(ctx.runId, step.id, artifacts, ctx.iteration)
    // Persist sessionIds + stepOutputs so crash recovery can rehydrate
    // multi-step workflow continuity (worker --continue chains and custom
    // step outputs not captured by the builtin artifact map).
    checkpoint.persistRunState(ctx.runId, ctx.sessionIds, ctx.stepOutputs)
    // Extend the lease — a long workflow may run longer than the lease
    // duration and would otherwise fall to cleanExpired mid-run.
    if (deps.leaseHeartbeat) {
      const held = deps.leaseHeartbeat()
      if (!held) {
        logger.warn(
          { runId: ctx.runId, phase: step.id },
          'Lease heartbeat failed — lease was released or taken over. Continuing cautiously.',
        )
      }
    }
    ctx = recordPhase(ctx, step.id, stepSuccess ? 'success' : 'failure', {}, stepStartedAt)

    // Fire onPlanReady after plan step completes with a plan
    if (step.type === 'worker' && step.role === 'planner' && ctx.plan && deps.onPlanReady) {
      try { await deps.onPlanReady(ctx) } catch (err) {
        logger.warn({ runId: ctx.runId, repo: ctx.repo, issueNumber: ctx.issueNumber, err }, 'Failed to post plan summary')
      }
    }

    // Handle decide step routing
    if (step.type === 'decide' && result.decision) {
      const decision = result.decision
      logger.info({ runId: ctx.runId, decision: decision.action, reason: decision.reason }, 'Loop decision')

      // Persist decision outcome BEFORE taking action. If a crash happens
      // between the decision and the terminal state write, resume will
      // replay the outcome rather than re-routing to iterate.
      checkpoint.recordDecisionOutcome(ctx.runId, step.id, {
        action: decision.action,
        reason: decision.reason,
        blockReason: decision.action === 'block' ? decision.blockReason : null,
      })

      switch (decision.action) {
        case 'publish': {
          const planningOnly = isPlanningIssue(ctx.issue.labels, ctx.repoConfig)
          const planningOnlyPrdPath = planningOnly
            ? buildPlanningPrdPath(ctx.issueNumber, ctx.issue.title, ctx.repoConfig)
            : undefined

          const commitResult = await commitChanges(
            ctx.worktreePath,
            ctx.issueNumber,
            ctx.issue.title,
            config.security,
            {
              planningOnlyPrdPath,
              issueLabels: ctx.issue.labels,
            },
          )
          if (!commitResult.committed) {
            logger.warn({ reason: commitResult.reason }, 'Commit skipped')
            if (commitResult.blockRun) {
              const blockMessage = commitResult.reason ?? 'Commit blocked by repository policy'
              return recordPhase(
                updateContext(ctx, {
                  currentPhase: 'blocked',
                  terminalStatus: 'blocked',
                  stepOutputs: {
                    ...ctx.stepOutputs,
                    blockMessage,
                  },
                }),
                'publish',
                'failure',
              )
            }
          }
          return recordPhase(
            updateContext(ctx, { currentPhase: 'completed', terminalStatus: 'publish' }),
            'publish',
            'success',
          )
        }

        case 'iterate': {
          // Snapshot verify results before clearing for stuck-loop detection
          const verifyHash = hashVerifyResults(ctx.verifyResults)
          const snapshot = { iteration: ctx.iteration, verifyHash }
          const updatedSnapshots = [...ctx.iterationSnapshots, snapshot]

          // Check if the loop is stuck (same verify output 2x in a row)
          const progress = assessProgress(verifyHash, ctx.iterationSnapshots)
          if (progress.status === 'stuck') {
            logger.warn({ runId: ctx.runId, iteration: ctx.iteration, verifyHash }, progress.reason)
            return recordPhase(
              updateContext(ctx, {
                currentPhase: 'blocked',
                terminalStatus: 'blocked',
                blockReason: 'iteration_limit',
                iterationSnapshots: updatedSnapshots,
                stepOutputs: {
                  ...ctx.stepOutputs,
                  blockMessage: `Loop stuck: ${progress.reason}`,
                },
              }),
              'decision',
              'failure',
            )
          }

          ctx = updateContext(ctx, {
            iteration: ctx.iteration + 1,
            reviewFindings: [...ctx.reviewFindings, ...decision.findings],
            reviewResult: null,
            verifyResults: [],
            iterationSnapshots: updatedSnapshots,
          })
          try { metrics?.incLoopIterations(ctx.repo) } catch { /* best-effort */ }
          logger.info({ runId: ctx.runId, iteration: ctx.iteration }, 'Iterating loop')

          const jumpTarget = step.onIterate
          const jumpIndex = steps.findIndex(s => s.id === jumpTarget)
          if (jumpIndex === -1) {
            logger.error({ runId: ctx.runId, jumpTarget }, 'Iterate target step not found')
            return recordPhase(
              updateContext(ctx, { currentPhase: 'error', terminalStatus: 'error' }),
              'decision',
              'failure',
            )
          }
          stepIndex = jumpIndex
          continue
        }

        case 'block':
          return recordPhase(
            updateContext(ctx, {
              currentPhase: 'blocked',
              terminalStatus: 'blocked',
              blockReason: decision.blockReason,
              stepOutputs: {
                ...ctx.stepOutputs,
                blockMessage: decision.reason,
              },
            }),
            'decision',
            'failure',
          )

        case 'error':
          return recordPhase(
            updateContext(ctx, { currentPhase: 'error', terminalStatus: 'error' }),
            'decision',
            'failure',
          )
      }
    }

    stepIndex++
  }

  // Should not reach here — the decide step should have routed to a terminal state
  return recordPhase(
    updateContext(ctx, { currentPhase: 'error', terminalStatus: 'error' }),
    'error',
    'failure',
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { WorkflowStep } from './workflow.js'

function resolveStartingStepIndex(
  steps: WorkflowStep[],
  resumedCtx: RunContext | null,
  checkpointPhaseData: Readonly<Record<string, unknown>>,
  completedPhases: readonly string[],
): number {
  if (!resumedCtx) return 0

  const resumedPhaseIndex = steps.findIndex((step) => step.id === resumedCtx.currentPhase)
  if (resumedPhaseIndex === -1) return 0

  const resumedStep = steps[resumedPhaseIndex]!
  // Completed-phases sentinel is authoritative when present. Pre-migration
  // data (no sentinel) falls back to the artifact-shape check.
  const hasCompletedSentinel = completedPhases.length > 0
  const artifactComplete = isStepCheckpointComplete(resumedStep, checkpointPhaseData[resumedStep.id])
  const isCompletedCheckpoint = hasCompletedSentinel
    ? completedPhases.includes(resumedStep.id) && artifactComplete
    : artifactComplete
  if (!isCompletedCheckpoint) {
    return resumedPhaseIndex
  }

  if (resumedStep.type === 'decide') {
    // Decide steps without a persisted terminal outcome (checked earlier)
    // fall through to the iterate target on resume — the crashed attempt
    // chose iterate.
    const iterateTargetIndex = steps.findIndex((step) => step.id === resumedStep.onIterate)
    return iterateTargetIndex >= 0 ? iterateTargetIndex : 0
  }

  const nextStepIndex = resumedPhaseIndex + 1
  return nextStepIndex < steps.length ? nextStepIndex : resumedPhaseIndex
}

/**
 * If a persisted decision outcome is terminal (publish/block/error),
 * return it so the engine can replay the outcome on resume. iterate is
 * not terminal — the crashed attempt went on to re-run earlier steps.
 */
function findTerminalDecisionOutcome(
  outcomes: Record<string, PersistedDecisionOutcome>,
): { phase: string; outcome: PersistedDecisionOutcome } | null {
  for (const [phase, outcome] of Object.entries(outcomes)) {
    if (outcome.action === 'publish' || outcome.action === 'block' || outcome.action === 'error') {
      return { phase, outcome }
    }
  }
  return null
}

function applyPersistedDecisionOutcome(
  ctx: RunContext,
  terminal: { phase: string; outcome: PersistedDecisionOutcome },
): RunContext {
  const { phase, outcome } = terminal
  switch (outcome.action) {
    case 'publish':
      return recordPhase(
        updateContext(ctx, { currentPhase: 'completed', terminalStatus: 'publish' }),
        phase,
        'success',
      )
    case 'block':
      return recordPhase(
        updateContext(ctx, {
          currentPhase: 'blocked',
          terminalStatus: 'blocked',
          blockReason: (outcome.blockReason ?? null) as RunContext['blockReason'],
          stepOutputs: {
            ...ctx.stepOutputs,
            blockMessage: outcome.reason ?? 'Blocked by prior decide outcome',
          },
        }),
        phase,
        'failure',
      )
    case 'error':
      return recordPhase(
        updateContext(ctx, { currentPhase: 'error', terminalStatus: 'error' }),
        phase,
        'failure',
      )
    default:
      return ctx
  }
}

function getCheckpointPhaseData(
  db: Database.Database,
  runId: string,
): Record<string, unknown> {
  const row = db
    .prepare('SELECT phase_data FROM runs WHERE id = ?')
    .get(runId) as { phase_data: string | null } | undefined
  if (!row?.phase_data) return {}

  try {
    const parsed = JSON.parse(row.phase_data) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return parsed
  } catch {
    return {}
  }
}

function isStepCheckpointComplete(step: WorkflowStep, rawArtifacts: unknown): boolean {
  if (typeof rawArtifacts !== 'object' || rawArtifacts === null || Array.isArray(rawArtifacts)) {
    return false
  }

  const artifacts = rawArtifacts as Record<string, unknown>
  switch (step.type) {
    case 'worker':
      if (step.role === 'planner') return artifacts['plan'] !== null && artifacts['plan'] !== undefined
      if (step.role === 'coder') return artifacts['codeResult'] !== null && artifacts['codeResult'] !== undefined
      if (step.role === 'reviewer') return artifacts['reviewResult'] !== null && artifacts['reviewResult'] !== undefined
      // Custom-role workers: checkpoint is complete only if stepOutput was
      // persisted (meaning the step ran to completion and its output was
      // written back). Without this the resume path could skip a crashed
      // custom step thinking it was done.
      return 'stepOutput' in artifacts
    case 'verify':
      return Array.isArray(artifacts['verifyResults'])
    case 'decide':
      return true
  }
}

function determineStepSuccess(step: WorkflowStep, ctx: RunContext): boolean {
  switch (step.type) {
    case 'worker':
      if (step.role === 'planner') return ctx.plan !== null
      if (step.role === 'coder') return ctx.codeResult !== null
      if (step.role === 'reviewer') return ctx.reviewResult !== null
      return true
    case 'verify':
      return ctx.verifyResults.length > 0 && ctx.verifyResults.every(r => r.passed)
    case 'decide':
      return true
  }
}

function buildStepArtifacts(step: WorkflowStep, ctx: RunContext): Record<string, unknown> {
  switch (step.type) {
    case 'worker':
      if (step.role === 'planner') return { plan: ctx.plan }
      if (step.role === 'coder') return { codeResult: ctx.codeResult }
      if (step.role === 'reviewer') return { reviewResult: ctx.reviewResult }
      // Custom-role workers: persist the step's own output so resume can
      // tell that work was completed. Without this, isStepCheckpointComplete
      // fell through to `return true` for custom roles but phase_data
      // recorded `{}`, so on resume the step was skipped AND its output
      // was lost.
      return { stepOutput: ctx.stepOutputs[step.id] ?? null }
    case 'verify':
      return { verifyResults: ctx.verifyResults }
    case 'decide':
      return {}
  }
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

function applyEstimatedWorkerCost(
  ctx: RunContext,
  costTracker: CostTracker,
  costConfig: Config['cost'] | undefined,
  securityConfig: Config['security'],
  stepId: string,
  role: string,
  pricingIdentity: {
    role: string
    workerType: string
    pricingModel: string | null
    fallbackMinuteUsd?: number | null
  } | undefined,
  durationMs: number,
  tokenUsage?: TokenUsage,
): {
  ctx: RunContext
  budget: BudgetStatus
} {
  const estimate = estimateWorkerCost({
    cost: costConfig,
    identity: {
      role,
      workerType: pricingIdentity?.workerType,
      pricingModel: pricingIdentity?.pricingModel,
      fallbackMinuteUsd: pricingIdentity?.fallbackMinuteUsd,
    },
    durationMs,
    tokenUsage,
  })
  const estimatedCost = estimate.usd

  if (estimate.usedDefaultModelFallback && pricingIdentity?.pricingModel) {
    logger.warn(
      {
        runId: ctx.runId,
        phase: stepId,
        requestedModelKey: estimate.modelKey,
        resolvedModelKey: estimate.resolvedModelKey,
      },
      'Worker pricing model key missing from cost.pricing.models; falling back to default model pricing',
    )
  }

  if (estimatedCost <= 0 && !tokenUsage) {
    return {
      ctx,
      budget: { overBudget: false },
    }
  }

  const budget = costTracker.recordCostAndCheckBudget(
    ctx.runId,
    estimatedCost,
    tokenUsage,
    {
      stepId,
      workerType: pricingIdentity?.workerType ?? null,
    },
    securityConfig,
    costConfig,
  )
  if (estimatedCost <= 0) {
    return { ctx, budget }
  }

  return {
    ctx: updateContext(ctx, {
      estimatedCostUsd: Number((ctx.estimatedCostUsd + estimatedCost).toFixed(6)),
    }),
    budget,
  }
}
