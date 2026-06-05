import type { RunContext, ReviewerOutput } from './types.js'
import type { Config } from '../config/schema.js'
import type { WorkerAdapter } from '../workers/types.js'
import type { MetricsService } from '../metrics/service.js'
import { getPostPublishSteps, reviewerKeyForStep, runWhenForStep, type ResolvedWorkflow, type WorkerStep, type WorkflowStep } from './workflow.js'
import {
  Checkpoint,
  applyPersistedDecisionOutcome,
  extractCompletedPhases,
  extractDecisionOutcomes,
  findTerminalDecisionOutcome,
  resolveStartingStepIndex,
} from './checkpoint.js'
import { updateContext, recordPhase } from './context.js'
import { hashVerifyResults, assessProgress } from './progress.js'
import { commitChanges } from './commit.js'
import {
  buildStepArtifacts,
  determineStepSuccess,
  executeStep,
  type StepDependencies,
} from './step-executor.js'
import { runVerifyGate } from './verify-gate.js'
import { FileRunArtifactWriter } from './run-artifacts.js'
import { CostTracker, describeBudgetBlock, costLimitRecoveryHint } from './cost.js'
import {
  applyEstimatedWorkerCost,
  checkRunawayBudget,
  describeRunawayBudgetBlock,
  runawayLimitToBlockReason,
} from './cost/budget-guard.js'
import { runPostWorkerHooks } from './hooks.js'
import { WorkerError, isTransientWorkerError } from '../workers/errors.js'
import { workerErrorToBlockedReason } from './worker-errors.js'
import { blocked, blockedReasonToLegacy } from './state.js'
import { blockExit } from './block-exit.js'
import { logger } from '../utils/logger.js'
import { utcIsoFromMs } from '../utils/time.js'
import type Database from 'better-sqlite3'
import { buildPlanningPrdPath, isPlanningIssue } from '../planning/mode.js'
import type { AgentEvent } from '../events/types.js'
import type { ReactionEnvelope } from '../reactions/types.js'
import { mergeReviewFindings } from './review-findings.js'
import { buildStepHandoff } from './handoff.js'
import { classifyPhaseFailure } from './classifier.js'
import { recordClassifier } from '../state/retro.js'
import type { LoopDecision } from './types.js'
import { withPublishedPrContext } from './post-publish.js'

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

export interface ExecutePostPublishStepsInput extends LoopDependencies {
  ctx: RunContext
  prNumber: number
  prUrl: string
  onPostPublishReview?: (input: PostPublishReviewInput) => Promise<PostPublishReviewEffect | null>
}

export interface PostPublishExecutionResult {
  ctx: RunContext
  reactions: ReactionEnvelope[]
}

export type PostPublishStepResult = 'ok' | 'comment_only' | 'continue_queued' | 'error'

export interface PostPublishReviewInput {
  ctx: RunContext
  step: WorkerStep
  review: ReviewerOutput
  prNumber: number
  prUrl: string
}

export interface PostPublishReviewEffect {
  reaction?: ReactionEnvelope | null
  result: Exclude<PostPublishStepResult, 'error'>
}

function assertMainLoopWorkflowBoundary(steps: readonly WorkflowStep[]): void {
  const decideIndex = steps.findIndex((step) => step.type === 'decide')
  if (decideIndex === -1) {
    throw new Error('Workflow must include a decide step for executeLoop')
  }

  const postPublishIds = new Set<string>()
  for (const [index, step] of steps.entries()) {
    if (step.type !== 'worker' || runWhenForStep(step) !== 'post-publish') continue
    postPublishIds.add(step.id)
    if (index < decideIndex) {
      throw new Error(`post-publish step "${step.id}" must be declared after decide`)
    }
  }

  for (const step of steps) {
    if (step.type === 'decide' && postPublishIds.has(step.onIterate)) {
      throw new Error(`decide step "${step.id}" cannot iterate to post-publish step "${step.onIterate}"`)
    }
  }
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
  const steps = deps.workflow.steps
  assertMainLoopWorkflowBoundary(steps)
  const artifactWriter = config.storage.logsRoot.trim().length > 0
    ? new FileRunArtifactWriter(config.storage.logsRoot)
    : undefined
  const checkpoint = new Checkpoint(db, artifactWriter, metrics)
  const costTracker = new CostTracker(db)

  const resumedCtx = checkpoint.resumeFromCheckpoint(initialCtx.runId, initialCtx)
  let ctx = resumedCtx ?? initialCtx

  const stepDeps: StepDependencies = {
    adapters: deps.adapters,
    config: deps.config,
    envOverrides: deps.envOverrides,
    metrics: deps.metrics,
    onAgentEvent: deps.onAgentEvent,
    db: deps.db,
  }

  const checkpointPhaseData = checkpoint.getPhaseData(initialCtx.runId)
  const persistedDecisions = extractDecisionOutcomes(checkpointPhaseData)

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

  let stepIndex = resolveStartingStepIndex(steps, resumedCtx, checkpointPhaseData, extractCompletedPhases(checkpointPhaseData))

  while (stepIndex < steps.length) {
    const step = steps[stepIndex]!

    if (step.type === 'worker' && runWhenForStep(step) === 'post-publish') {
      throw new Error(`Invariant violation: executeLoop reached post-publish step "${step.id}"`)
    }

    // Skip step if skipWhen matches triage level. Emit paired
    // phase_started/phase_completed events so the event stream stays
    // well-formed and observability consumers see the skip.
    if ('skipWhen' in step && step.skipWhen === ctx.triageResult.level) {
      checkpoint.phaseSkipped(ctx.runId, step.id, ctx.iteration)
      ctx = recordPhase(ctx, step.id, 'skipped')
      stepIndex++
      continue
    }

    if (step.type === 'worker') {
      const workerOutcome = await executeGuardedWorkerStep({
        ctx,
        step,
        steps,
        stepIndex,
        deps,
        stepDeps,
        checkpoint,
        costTracker,
      })
      ctx = workerOutcome.ctx
      if (workerOutcome.action === 'return') return ctx
      stepIndex++
      continue
    }

    // Execute step
    const stepStart = Date.now()
    const stepStartedAt = utcIsoFromMs(stepStart)
    ctx = updateContext(ctx, { currentPhase: step.id })
    checkpoint.phaseStarted(ctx.runId, step.id, ctx.iteration)

    if (step.type === 'verify') {
      const gate = await runVerifyGate({
        ctx,
        step,
        stepDeps,
        checkpoint,
        steps,
        stepIndex,
        loopConfig: config.loop,
        metrics,
        leaseHeartbeat: deps.leaseHeartbeat,
        startedAtMs: stepStart,
        startedAtIso: stepStartedAt,
      })
      ctx = gate.ctx
      if (gate.action === 'return') return ctx
      if (gate.action === 'continue') {
        stepIndex = gate.stepIndex
        continue
      }
      stepIndex++
      continue
    }

    let result: Awaited<ReturnType<typeof executeStep>>
    try {
      result = await executeStep(ctx, step, stepDeps)
    } catch (err) {
      // Transient worker failures bubble to the poller's infra-retry
      // path; everything else (auth, timeout, parse, token-capture,
      // rate-limit) becomes a typed blocked state so the attempt
      // doesn't silently fall into an expensive full-run retry loop.
      if (err instanceof WorkerError && !isTransientWorkerError(err)) {
        const reason = workerErrorToBlockedReason(err)
        const blockedState = blocked(reason)
        logger.error(
          {
            runId: ctx.runId,
            phase: step.id,
            adapter: err.adapter,
            code: err.code,
            message: err.message,
          },
          `${step.id} worker error → blocking attempt`,
        )
        return blockExit(
          ctx,
          checkpoint,
          step.id,
          blockedReasonToLegacy(reason),
          blockedState.message,
          stepStartedAt,
        )
      }
      throw err
    }
    ctx = result.ctx

    // Determine step success
    const stepSuccess = determineStepSuccess(step, ctx)

    // Checkpoint and record
    const artifacts = buildStepArtifacts(step, ctx)
    const handoff = buildStepHandoff({ ctx, step, steps, stepIndex, tokenUsage: result.tokenUsage })
    checkpoint.phaseCompleted(ctx.runId, step.id, artifacts, ctx.iteration, handoff ?? undefined)
    if (handoff) {
      try { metrics?.incHandoffs(handoff.kind) } catch { /* best-effort */ }
    }
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

    runClassifierIfEnabled(db, ctx, result.decision ?? null, deps.config)

    // Handle decide step routing
    if (step.type === 'decide' && result.decision) {
      const decision = result.decision
      logger.info({ runId: ctx.runId, decision: decision.action, reason: decision.reason }, 'Loop decision')

      // Persist decision outcome BEFORE taking action. If a crash happens
      // between the decision and the terminal state write, resume will
      // replay the outcome rather than re-routing to iterate.
      //
      // The persisted shape uses the legacy BlockReason string during
      // the R1 bridge — `PersistedDecisionOutcome` isn't retyped yet.
      // R5 (phase_data zod schema) will migrate this storage layer.
      checkpoint.recordDecisionOutcome(ctx.runId, step.id, {
        action: decision.action,
        reason: decision.reason,
        blockReason:
          decision.action === 'block'
            ? blockedReasonToLegacy(decision.state.reason)
            : null,
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
              return blockExit(
                ctx,
                checkpoint,
                'publish',
                'verify_config',
                blockMessage,
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
            return blockExit(
              updateContext(ctx, {
                iterationSnapshots: updatedSnapshots,
              }),
              checkpoint,
              'decision',
              'stuck_loop',
              `Loop stuck: ${progress.reason}`,
            )
          }

          ctx = updateContext(ctx, {
            iteration: ctx.iteration + 1,
            reviewFindings: mergeReviewFindings(ctx.reviewFindings, decision.findings),
            reviewResults: {},
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
          return blockExit(
            ctx,
            checkpoint,
            'decision',
            blockedReasonToLegacy(decision.state.reason),
            decision.reason,
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

export async function executePostPublishSteps(
  input: ExecutePostPublishStepsInput,
): Promise<PostPublishExecutionResult> {
  const { db, config, metrics } = input
  const artifactWriter = config.storage.logsRoot.trim().length > 0
    ? new FileRunArtifactWriter(config.storage.logsRoot)
    : undefined
  const checkpoint = new Checkpoint(db, artifactWriter, metrics)
  const costTracker = new CostTracker(db)
  const stepDeps: StepDependencies = {
    adapters: input.adapters,
    config: input.config,
    envOverrides: input.envOverrides,
    metrics: input.metrics,
    onAgentEvent: input.onAgentEvent,
    db,
  }
  const steps = getPostPublishSteps(input.workflow)
  const resumedCtx = checkpoint.resumeFromCheckpoint(input.ctx.runId, input.ctx)
  const checkpointPhaseData = checkpoint.getPhaseData(input.ctx.runId)
  let stepIndex = resolveStartingStepIndex(
    steps,
    resumedCtx,
    checkpointPhaseData,
    extractCompletedPhases(checkpointPhaseData),
  )
  let ctx = withPublishedPrContext(resumedCtx ?? input.ctx, input.prNumber, input.prUrl)
  const reactions: ReactionEnvelope[] = []

  for (; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]!
    let stepResult: PostPublishStepResult = 'ok'
    try {
      const workerOutcome = await executeGuardedWorkerStep({
        ctx,
        step,
        steps,
        stepIndex,
        deps: input,
        stepDeps,
        checkpoint,
        costTracker,
      })
      ctx = workerOutcome.ctx
      if (workerOutcome.action === 'return') {
        stepResult = 'error'
        return { ctx, reactions }
      }
      const review = getReviewerOutputForStep(ctx, step)
      if (review && input.onPostPublishReview) {
        const effect = await input.onPostPublishReview({
          ctx,
          step,
          review,
          prNumber: input.prNumber,
          prUrl: input.prUrl,
        })
        if (effect?.reaction) reactions.push(effect.reaction)
        stepResult = effect?.result ?? 'ok'
      }
    } catch (err) {
      stepResult = 'error'
      throw err
    } finally {
      try { metrics?.incPostPublishStep(step.id, stepResult) } catch { /* best-effort */ }
    }
  }

  return { ctx, reactions }
}

type GuardedWorkerStepOutcome =
  | { action: 'continue'; ctx: RunContext }
  | { action: 'return'; ctx: RunContext }

interface ExecuteGuardedWorkerStepInput {
  ctx: RunContext
  step: WorkerStep
  steps: readonly WorkflowStep[]
  stepIndex: number
  deps: LoopDependencies
  stepDeps: StepDependencies
  checkpoint: Checkpoint
  costTracker: CostTracker
}

function getReviewerOutputForStep(ctx: RunContext, step: WorkerStep): ReviewerOutput | null {
  const key = reviewerKeyForStep(step)
  return ctx.reviewResults[key] ?? null
}

async function executeGuardedWorkerStep(
  input: ExecuteGuardedWorkerStepInput,
): Promise<GuardedWorkerStepOutcome> {
  const { deps, step, stepDeps, checkpoint, costTracker } = input
  const { db, config, metrics } = deps
  let ctx = input.ctx

  const preRunawayBudget = checkRunawayBudget(db, costTracker, ctx, config.loop)
  if (preRunawayBudget.overBudget) {
    const blockMessage = describeRunawayBudgetBlock(preRunawayBudget)
    logger.warn(
      {
        runId: ctx.runId,
        limit: preRunawayBudget.limit,
        actual: preRunawayBudget.actual,
        threshold: preRunawayBudget.threshold,
      },
      'Runaway budget exceeded',
    )
    return {
      action: 'return',
      ctx: blockExit(
        ctx,
        checkpoint,
        step.id,
        runawayLimitToBlockReason(preRunawayBudget.limit),
        blockMessage,
      ),
    }
  }

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
    return {
      action: 'return',
      ctx: blockExit(
        ctx,
        checkpoint,
        step.id,
        'cost_limit',
        blockMessage,
      ),
    }
  }

  const stepStart = Date.now()
  const stepStartedAt = utcIsoFromMs(stepStart)
  ctx = updateContext(ctx, { currentPhase: step.id })
  checkpoint.phaseStarted(ctx.runId, step.id, ctx.iteration)

  let result: Awaited<ReturnType<typeof executeStep>>
  try {
    result = await executeStep(ctx, step, stepDeps)
  } catch (err) {
    // Transient worker failures bubble to the poller's infra-retry
    // path; everything else (auth, timeout, parse, token-capture,
    // rate-limit) becomes a typed blocked state so the attempt
    // doesn't silently fall into an expensive full-run retry loop.
    if (err instanceof WorkerError && !isTransientWorkerError(err)) {
      const reason = workerErrorToBlockedReason(err)
      const blockedState = blocked(reason)
      logger.error(
        {
          runId: ctx.runId,
          phase: step.id,
          adapter: err.adapter,
          code: err.code,
          message: err.message,
        },
        `${step.id} worker error → blocking attempt`,
      )
      return {
        action: 'return',
        ctx: blockExit(
          ctx,
          checkpoint,
          step.id,
          blockedReasonToLegacy(reason),
          blockedState.message,
          stepStartedAt,
        ),
      }
    }
    throw err
  }

  ctx = result.ctx
  const stepDurationMs = Date.now() - stepStart
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
    metrics,
  )
  ctx = costResult.ctx

  // A coder that ran in an unwritable environment (read-only sandbox, every
  // patch rejected) can never succeed on retry. Cost for this attempt has
  // just been recorded above, so the spend is visible; now block with a
  // typed `environmentFault` reason instead of churning the empty-diff retry
  // budget on a doomed environment (issue #341).
  if (result.environmentFault) {
    const adapter = result.pricingIdentity?.workerType ?? 'worker'
    const reason = {
      type: 'environmentFault' as const,
      adapter,
      step: step.id,
      detail: result.environmentFault,
    }
    const blockedState = blocked(reason)
    logger.error(
      { runId: ctx.runId, phase: step.id, adapter, detail: result.environmentFault },
      `${step.id} environment fault → blocking attempt`,
    )
    return {
      action: 'return',
      ctx: blockExit(
        ctx,
        checkpoint,
        step.id,
        blockedReasonToLegacy(reason),
        blockedState.message,
        stepStartedAt,
      ),
    }
  }

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
    return {
      action: 'return',
      ctx: blockExit(
        ctx,
        checkpoint,
        step.id,
        'cost_limit',
        blockMessage,
        stepStartedAt,
      ),
    }
  }

  const postRunawayBudget = checkRunawayBudget(db, costTracker, ctx, config.loop)
  if (postRunawayBudget.overBudget) {
    const blockMessage = describeRunawayBudgetBlock(postRunawayBudget)
    logger.warn(
      {
        runId: ctx.runId,
        phase: step.id,
        limit: postRunawayBudget.limit,
        actual: postRunawayBudget.actual,
        threshold: postRunawayBudget.threshold,
      },
      'Runaway budget exceeded after recording worker cost',
    )
    return {
      action: 'return',
      ctx: blockExit(
        ctx,
        checkpoint,
        step.id,
        runawayLimitToBlockReason(postRunawayBudget.limit),
        blockMessage,
        stepStartedAt,
      ),
    }
  }

  const workerHookBlock = await runPostWorkerHooks(ctx, step, config)
  if (workerHookBlock) {
    return {
      action: 'return',
      ctx: blockExit(
        ctx,
        checkpoint,
        step.id,
        workerHookBlock.blockReason,
        workerHookBlock.blockMessage,
        stepStartedAt,
      ),
    }
  }
  try { metrics?.observePhaseDuration(step.id, stepDurationMs / 1000) } catch { /* best-effort */ }

  const stepSuccess = determineStepSuccess(step, ctx)
  if (step.role === 'planner' && !stepSuccess && config.loop.stopOnPlannerFailure) {
    logger.error({ runId: ctx.runId }, 'Planner failed and stopOnPlannerFailure is true')
    const artifacts = buildStepArtifacts(step, ctx)
    const handoff = buildStepHandoff({ ctx, step, steps: input.steps, stepIndex: input.stepIndex, tokenUsage: result.tokenUsage })
    checkpoint.phaseCompleted(ctx.runId, step.id, artifacts, ctx.iteration, handoff ?? undefined)
    if (handoff) {
      try { metrics?.incHandoffs(handoff.kind) } catch { /* best-effort */ }
    }
    return {
      action: 'return',
      ctx: recordPhase(
        updateContext(ctx, { currentPhase: 'error', terminalStatus: 'error' }),
        step.id,
        'failure',
        {},
        stepStartedAt,
      ),
    }
  }

  const artifacts = buildStepArtifacts(step, ctx)
  const handoff = buildStepHandoff({ ctx, step, steps: input.steps, stepIndex: input.stepIndex, tokenUsage: result.tokenUsage })
  checkpoint.phaseCompleted(ctx.runId, step.id, artifacts, ctx.iteration, handoff ?? undefined)
  if (handoff) {
    try { metrics?.incHandoffs(handoff.kind) } catch { /* best-effort */ }
  }
  checkpoint.persistRunState(ctx.runId, ctx.sessionIds, ctx.stepOutputs)
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

  if (step.role === 'planner' && ctx.plan && deps.onPlanReady) {
    try { await deps.onPlanReady(ctx) } catch (err) {
      logger.warn({ runId: ctx.runId, repo: ctx.repo, issueNumber: ctx.issueNumber, err }, 'Failed to post plan summary')
    }
  }

  return { action: 'continue', ctx }
}

function runClassifierIfEnabled(
  db: Database.Database,
  ctx: RunContext,
  decision: LoopDecision | null,
  config: Config,
): void {
  if (!config.observability?.recordPromptCompilations) {
    // The classifier shares the same observability gate as prompt
    // compilations — same disable knob to avoid two flags for one concept.
  }
  const lastPhase = ctx.phaseHistory[ctx.phaseHistory.length - 1]
  if (!lastPhase) return
  try {
    const result = classifyPhaseFailure(ctx, lastPhase, decision ?? undefined)
    if (!result) return
    recordClassifier(db, {
      runId: ctx.runId,
      phase: lastPhase.phase,
      stepId: lastPhase.phase,
      classifier: result.classifier,
      severity: result.severity,
      evidence: result.evidence,
    })
  } catch (err) {
    logger.debug({ runId: ctx.runId, err }, 'Failed to record classifier')
  }
}
