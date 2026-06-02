import type { RunContext } from './types.js'
import type { Config } from '../config/schema.js'
import type { WorkerAdapter } from '../workers/types.js'
import type { MetricsService } from '../metrics/service.js'
import { runWhenForStep, type ResolvedWorkflow } from './workflow.js'
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
import { mergeReviewFindings } from './review-findings.js'
import { buildStepHandoff } from './handoff.js'

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
  }

  const steps = deps.workflow.steps
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
      checkpoint.phaseSkipped(ctx.runId, step.id, ctx.iteration)
      ctx = recordPhase(ctx, step.id, 'skipped')
      stepIndex++
      continue
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

    // Cost check before worker steps
    if (step.type === 'worker') {
      const runawayBudget = checkRunawayBudget(db, costTracker, ctx, config.loop)
      if (runawayBudget.overBudget) {
        const blockMessage = describeRunawayBudgetBlock(runawayBudget)
        logger.warn(
          {
            runId: ctx.runId,
            limit: runawayBudget.limit,
            actual: runawayBudget.actual,
            threshold: runawayBudget.threshold,
          },
          'Runaway budget exceeded',
        )
        return blockExit(
          ctx,
          checkpoint,
          step.id,
          runawayLimitToBlockReason(runawayBudget.limit),
          blockMessage,
        )
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
        return blockExit(
          ctx,
          checkpoint,
          step.id,
          'cost_limit',
          blockMessage,
        )
      }
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
        metrics,
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
        return blockExit(
          ctx,
          checkpoint,
          step.id,
          'cost_limit',
          blockMessage,
          stepStartedAt,
        )
      }
      const runawayBudget = checkRunawayBudget(db, costTracker, ctx, config.loop)
      if (runawayBudget.overBudget) {
        const blockMessage = describeRunawayBudgetBlock(runawayBudget)
        logger.warn(
          {
            runId: ctx.runId,
            phase: step.id,
            limit: runawayBudget.limit,
            actual: runawayBudget.actual,
            threshold: runawayBudget.threshold,
          },
          'Runaway budget exceeded after recording worker cost',
        )
        return blockExit(
          ctx,
          checkpoint,
          step.id,
          runawayLimitToBlockReason(runawayBudget.limit),
          blockMessage,
          stepStartedAt,
        )
      }
      const workerHookBlock = await runPostWorkerHooks(ctx, step, config)
      if (workerHookBlock) {
        return blockExit(
          ctx,
          checkpoint,
          step.id,
          workerHookBlock.blockReason,
          workerHookBlock.blockMessage,
          stepStartedAt,
        )
      }
      try { metrics?.observePhaseDuration(step.id, stepDurationMs / 1000) } catch { /* best-effort */ }
    }

    // Determine step success
    const stepSuccess = determineStepSuccess(step, ctx)

    // stopOnPlannerFailure check
    if (step.type === 'worker' && step.role === 'planner' && !stepSuccess && config.loop.stopOnPlannerFailure) {
      logger.error({ runId: ctx.runId }, 'Planner failed and stopOnPlannerFailure is true')
      const artifacts = buildStepArtifacts(step, ctx)
      const handoff = buildStepHandoff({ ctx, step, steps, stepIndex, tokenUsage: result.tokenUsage })
      checkpoint.phaseCompleted(ctx.runId, step.id, artifacts, ctx.iteration, handoff ?? undefined)
      if (handoff) {
        try { metrics?.incHandoffs(handoff.kind) } catch { /* best-effort */ }
      }
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
            reviewResult: null,
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
