import type { RunContext } from './types.js'
import type { Config } from '../config/schema.js'
import type { WorkerAdapter } from '../workers/types.js'
import type { MetricsService } from '../metrics/service.js'
import type { ResolvedWorkflow } from './workflow.js'
import type { PersistedDecisionOutcome } from './checkpoint.js'
import { findTerminalDecisionOutcome } from './checkpoint.js'
import { updateContext, recordPhase } from './context.js'
import { hashVerifyResults, assessProgress } from './progress.js'
import { commitChanges } from './commit.js'
import { checkWorktreeScope } from './diff-guard.js'
import { executeStep, type StepDependencies } from './step-executor.js'
import { Checkpoint } from './checkpoint.js'
import { FileRunArtifactWriter } from './run-artifacts.js'
import { CostTracker, describeBudgetBlock, costLimitRecoveryHint, type BudgetStatus } from './cost.js'
import { estimateTheoreticalCostUsd, estimateWorkerCost } from './pricing.js'
import { allRequiredVerifyPassed } from './verifier.js'
import {
  WorkerAuthError,
  WorkerError,
  WorkerParseError,
  WorkerRateLimitError,
  WorkerTimeoutError,
  WorkerTokenCaptureError,
  WorkerTransientError,
  isTransientWorkerError,
} from '../workers/errors.js'
import {
  assertNever,
  blocked,
  blockedReasonToLegacy,
  type BlockedReason,
} from './state.js'
import { decideEmptyDiffRetry } from './decision.js'
import { logger } from '../utils/logger.js'
import { parseUtcTimestampMs, utcIsoFromMs } from '../utils/time.js'
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
  const artifactWriter = config.storage.logsRoot.trim().length > 0
    ? new FileRunArtifactWriter(config.storage.logsRoot)
    : undefined
  const checkpoint = new Checkpoint(db, artifactWriter)
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
        checkpoint.phaseBlocked(ctx.runId, step.id, blockMessage, ctx.iteration)
        return recordPhase(
          updateContext(ctx, {
            currentPhase: 'blocked',
            terminalStatus: 'blocked',
            blockReason: 'iteration_limit',
            stepOutputs: {
              ...ctx.stepOutputs,
              blockMessage,
            },
          }),
          step.id,
          'failure',
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
        checkpoint.phaseBlocked(ctx.runId, step.id, blockedState.message, ctx.iteration)
        return recordPhase(
          updateContext(ctx, {
            currentPhase: 'blocked',
            terminalStatus: 'blocked',
            blockReason: blockedReasonToLegacy(reason),
            stepOutputs: {
              ...ctx.stepOutputs,
              blockMessage: blockedState.message,
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
        checkpoint.phaseBlocked(ctx.runId, step.id, blockMessage, ctx.iteration)
        return recordPhase(
          updateContext(ctx, {
            currentPhase: 'blocked',
            terminalStatus: 'blocked',
            blockReason: 'iteration_limit',
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
      // Plan-time scope guard: block over-scoped coder output *before*
      // spending verify + review on it. Production saw 157-file diffs
      // caught only at commit time; this fails fast at the code phase.
      if (step.role === 'coder') {
        const scope = await checkWorktreeScope(ctx.worktreePath, config.security)
        if (!scope.ok) {
          const blockMessage = `Scope guard: ${scope.reason}`
          logger.warn(
            { runId: ctx.runId, phase: step.id, stats: scope.stats },
            'Scope guard tripped after coder step — blocking before review',
          )
          checkpoint.phaseBlocked(ctx.runId, step.id, blockMessage, ctx.iteration)
          return recordPhase(
            updateContext(ctx, {
              currentPhase: 'blocked',
              terminalStatus: 'blocked',
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
      }
      try { metrics?.observePhaseDuration(step.id, stepDurationMs / 1000) } catch { /* best-effort */ }
    }
    if (step.type === 'verify') {
      try {
        metrics?.observePhaseDuration('verify', stepDurationMs / 1000)
        metrics?.observeVerifyDuration(stepDurationMs / 1000)
        const allPassed = ctx.verifyResults.length > 0 && allRequiredVerifyPassed(ctx.verifyResults)
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

    // Post-verify guard: hand off to the pure decision layer. Git
    // errors are treated as terminal (infra broken, no point
    // retrying); empty-diff scenarios route through
    // decideEmptyDiffRetry() which centralizes the retry-vs-block
    // policy alongside the rest of the routing rules in decision.ts.
    if (step.type === 'verify') {
      if (ctx.diffError) {
        const blockMessage = `Git diff failed: ${ctx.diffError}`
        checkpoint.phaseBlocked(ctx.runId, 'empty_diff_guard', blockMessage, ctx.iteration)
        return recordPhase(
          updateContext(ctx, {
            currentPhase: 'error',
            terminalStatus: 'error',
            stepOutputs: { ...ctx.stepOutputs, blockMessage },
          }),
          'empty_diff_guard',
          'failure',
        )
      }

      const emptyDiffDecision = decideEmptyDiffRetry(ctx, config.loop)
      if (emptyDiffDecision !== null) {
        if (emptyDiffDecision.action === 'block') {
          const blockMessage = emptyDiffDecision.state.message
          checkpoint.phaseBlocked(ctx.runId, 'empty_diff_guard', blockMessage, ctx.iteration)
          return recordPhase(
            updateContext(ctx, {
              currentPhase: 'blocked',
              terminalStatus: 'blocked',
              blockReason: blockedReasonToLegacy(emptyDiffDecision.state.reason),
              stepOutputs: { ...ctx.stepOutputs, blockMessage },
            }),
            'empty_diff_guard',
            'failure',
          )
        }

        if (emptyDiffDecision.action === 'iterate' && emptyDiffDecision.jumpTo === 'coder') {
          const coderIndex = findCoderStepBefore(steps, stepIndex)
          if (coderIndex === -1) {
            // Workflow is missing a prior coder step — can't act on
            // the jumpTo hint. Fall through to the reviewer.
            logger.warn(
              { runId: ctx.runId },
              'Empty diff but no coder step to retry — proceeding to review',
            )
          } else {
            ctx = updateContext(ctx, {
              emptyDiffRetries: ctx.emptyDiffRetries + 1,
              // Do NOT increment iteration — that's for review-driven cycles.
              verifyResults: [],
              reviewResult: null,
              diff: null,
              diffError: null,
            })
            logger.info(
              {
                runId: ctx.runId,
                emptyDiffRetries: ctx.emptyDiffRetries,
                maxRetries: config.loop.maxEmptyDiffRetries,
              },
              emptyDiffDecision.reason,
            )
            try { metrics?.incLoopIterations(ctx.repo) } catch { /* best-effort */ }
            stepIndex = coderIndex
            continue
          }
        }
      }

      // Reset emptyDiffRetries when coder produces a real diff
      if (ctx.diff && ctx.emptyDiffRetries > 0) {
        ctx = updateContext(ctx, { emptyDiffRetries: 0 })
      }
    }

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
              blockReason: blockedReasonToLegacy(decision.state.reason),
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
      return ctx.verifyResults.length > 0 && allRequiredVerifyPassed(ctx.verifyResults)
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
      return {
        verifyResults: ctx.verifyResults,
        diff: ctx.diff,
        diffError: ctx.diffError,
        emptyDiffRetries: ctx.emptyDiffRetries,
      }
    case 'decide':
      return {}
  }
}

interface RunawayBudgetStatus {
  overBudget: boolean
  limit?: 'run_tokens' | 'issue_tokens' | 'daily_tokens' | 'run_wall_clock'
  actual?: number
  threshold?: number
}

function checkRunawayBudget(
  db: Database.Database,
  costTracker: CostTracker,
  ctx: RunContext,
  loopConfig: Config['loop'],
): RunawayBudgetStatus {
  if (loopConfig.maxRunTokens > 0) {
    const runTokens = costTracker.getRunTokenUsage(ctx.runId).totalTokens
    if (runTokens >= loopConfig.maxRunTokens) {
      return {
        overBudget: true,
        limit: 'run_tokens',
        actual: runTokens,
        threshold: loopConfig.maxRunTokens,
      }
    }
  }

  if (loopConfig.maxIssueTokens > 0) {
    const issueTokens = getIssueChainTokenUsage(db, ctx.repo, ctx.issueNumber)
    if (issueTokens >= loopConfig.maxIssueTokens) {
      return {
        overBudget: true,
        limit: 'issue_tokens',
        actual: issueTokens,
        threshold: loopConfig.maxIssueTokens,
      }
    }
  }

  if (loopConfig.maxDailyTokens > 0) {
    const dailyTokens = costTracker.getDailyTokenUsage().totalTokens
    if (dailyTokens >= loopConfig.maxDailyTokens) {
      return {
        overBudget: true,
        limit: 'daily_tokens',
        actual: dailyTokens,
        threshold: loopConfig.maxDailyTokens,
      }
    }
  }

  if (loopConfig.maxRunWallClockMinutes > 0) {
    const startedAtMs = getRunStartedAtMs(db, ctx.runId)
    if (Number.isFinite(startedAtMs)) {
      const elapsedMinutes = (Date.now() - startedAtMs) / 60_000
      if (elapsedMinutes >= loopConfig.maxRunWallClockMinutes) {
        return {
          overBudget: true,
          limit: 'run_wall_clock',
          actual: elapsedMinutes,
          threshold: loopConfig.maxRunWallClockMinutes,
        }
      }
    }
  }

  return { overBudget: false }
}

function describeRunawayBudgetBlock(status: RunawayBudgetStatus): string {
  if (
    !status.overBudget
    || status.limit === undefined
    || status.actual === undefined
    || status.threshold === undefined
  ) {
    return 'Runaway budget exceeded'
  }

  switch (status.limit) {
    case 'run_tokens':
      return `Run token budget exceeded (${Math.floor(status.actual)} >= ${Math.floor(status.threshold)} tokens)`
    case 'issue_tokens':
      return `Issue token budget exceeded (${Math.floor(status.actual)} >= ${Math.floor(status.threshold)} tokens)`
    case 'daily_tokens':
      return `Daily token budget exceeded (${Math.floor(status.actual)} >= ${Math.floor(status.threshold)} tokens)`
    case 'run_wall_clock':
      return `Run wall-clock budget exceeded (${status.actual.toFixed(1)} >= ${status.threshold} minutes)`
  }
}

function getIssueChainTokenUsage(
  db: Database.Database,
  repo: string,
  issueNumber: number,
): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + cache_read_tokens), 0) AS total_tokens
     FROM runs
     WHERE repo = ? AND issue_number = ? AND parent_run_id IS NULL`,
  ).get(repo, issueNumber) as { total_tokens: number | null } | undefined
  return row?.total_tokens ?? 0
}

function getRunStartedAtMs(db: Database.Database, runId: string): number {
  const row = db
    .prepare('SELECT started_at FROM runs WHERE id = ?')
    .get(runId) as { started_at: string | null } | undefined
  return parseUtcTimestampMs(row?.started_at)
}

/**
 * Scan backward from the verify step to find the nearest coder step.
 * Returns -1 if no coder step is found.
 */
function findCoderStepBefore(steps: WorkflowStep[], verifyIndex: number): number {
  for (let i = verifyIndex - 1; i >= 0; i--) {
    const s = steps[i]!
    if (s.type === 'worker' && s.role === 'coder') return i
  }
  return -1
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
  metrics?: MetricsService,
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
    costModel: costConfig?.model,
  })
  const estimatedCost = estimate.usd
  // Layer-2 theoretical cost: priced from the same model regardless of
  // billing mode. Equals `estimatedCost` under pay-per-use; under a
  // subscription it's the metered price the work *would* have cost,
  // which drives subscription-quota overflow detection.
  const theoreticalCost = estimateTheoreticalCostUsd({
    cost: costConfig,
    identity: {
      role,
      workerType: pricingIdentity?.workerType,
      pricingModel: pricingIdentity?.pricingModel,
      fallbackMinuteUsd: pricingIdentity?.fallbackMinuteUsd,
    },
    durationMs,
    tokenUsage,
    costModel: costConfig?.model,
  })

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

  // R4b: Tag the cost entry with its provenance. When the worker
  // reported real token usage, use `reported_cli`; when it didn't and
  // the escape hatch is on (R4a), use `estimated_duration` so reports
  // can surface degraded-confidence rows. R4a throws before reaching
  // this path when tokenUsage is missing AND the escape hatch is off.
  const tokenSource = tokenUsage !== undefined ? 'reported_cli' : 'estimated_duration'
  const budget = costTracker.recordCostAndCheckBudget(
    ctx.runId,
    estimatedCost,
    tokenUsage,
    {
      stepId,
      workerType: pricingIdentity?.workerType ?? null,
      tokenSource,
      theoreticalCostUsd: theoreticalCost,
    },
    securityConfig,
    costConfig,
  )
  // R4f: increment the provenance counter after the recorder succeeds
  // so Prometheus scrapes see the distribution of reported-cli vs
  // fallback rows. Best-effort — metric failures never block a run.
  try { metrics?.incCostTokenSource(tokenSource) } catch { /* best-effort */ }
  if (estimatedCost > 0) {
    const agent = pricingIdentity?.workerType ?? 'unknown'
    try { metrics?.addEstimatedCost(ctx.repo, agent, estimatedCost) } catch { /* best-effort */ }
  }
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

/**
 * Map a non-transient `WorkerError` to the appropriate typed
 * `BlockedReason`. Exhaustive over the hierarchy: adding a new
 * `WorkerError` subclass without updating this switch is a compile
 * error on the `assertNever` default.
 */
function workerErrorToBlockedReason(err: WorkerError): BlockedReason {
  if (err instanceof WorkerAuthError) {
    // The legacy BlockedReason.authFailure only supports the three CLI
    // adapters; fall back to 'claude' if the adapter string is
    // unexpected (e.g. opencode before R1 expanded the union).
    const adapter: 'claude' | 'codex' | 'opencode' =
      err.adapterType === 'codex' || err.adapterType === 'opencode' ? err.adapterType : 'claude'
    return { type: 'authFailure', adapter }
  }
  if (err instanceof WorkerTimeoutError) {
    return {
      type: 'workerTimeout',
      adapter: err.adapter,
      step: err.step,
      timeoutMs: err.timeoutMs,
    }
  }
  if (err instanceof WorkerTokenCaptureError) {
    return { type: 'tokenCaptureFailed', adapter: err.adapter, step: err.step }
  }
  if (err instanceof WorkerParseError) {
    return { type: 'ambiguousReview', excerpt: err.message }
  }
  if (err instanceof WorkerRateLimitError) {
    // No first-class rate-limit reason yet; rate limits surface as an
    // ambiguous-review style excerpt so operators see the adapter + detail.
    return { type: 'ambiguousReview', excerpt: err.message }
  }
  if (err instanceof WorkerTransientError) {
    // Should never reach here — the caller filters transient errors
    // out before invoking this mapper. Included for exhaustiveness so
    // a future subclass addition fails at compile time.
    throw new Error(`workerErrorToBlockedReason called with transient error: ${err.message}`)
  }
  return assertNever(err as never, 'workerErrorToBlockedReason')
}
