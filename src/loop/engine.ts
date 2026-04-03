import type { RunContext } from './types.js'
import type { Config } from '../config/schema.js'
import type { WorkerAdapter } from '../workers/types.js'
import type { MetricsService } from '../metrics/service.js'
import type { ResolvedWorkflow } from './workflow.js'
import { updateContext, recordPhase } from './context.js'
import { commitChanges } from './commit.js'
import { executeStep, type StepDependencies } from './step-executor.js'
import { Checkpoint } from './checkpoint.js'
import { CostTracker } from './cost.js'
import { logger } from '../utils/logger.js'
import { utcIsoFromMs } from '../utils/time.js'
import type Database from 'better-sqlite3'
import { buildPlanningPrdPath, isPlanningIssue } from '../planning/mode.js'
import type { AgentEvent } from '../events/types.js'

export interface LoopDependencies {
  db: Database.Database
  config: Config
  adapters: Record<string, WorkerAdapter>
  workflow: ResolvedWorkflow
  envOverrides?: Record<string, string>
  metrics?: MetricsService
  onAgentEvent?: (event: AgentEvent) => void
  onPlanReady?: (ctx: RunContext) => Promise<void>
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

  let ctx = checkpoint.resumeFromCheckpoint(initialCtx.runId, initialCtx) ?? initialCtx

  const stepDeps: StepDependencies = {
    adapters: deps.adapters,
    config: deps.config,
    envOverrides: deps.envOverrides,
    metrics: deps.metrics,
    onAgentEvent: deps.onAgentEvent,
  }

  const steps = deps.workflow.steps
  let stepIndex = 0

  while (stepIndex < steps.length) {
    const step = steps[stepIndex]!

    // Skip step if skipWhen matches triage level
    if ('skipWhen' in step && step.skipWhen === ctx.triageResult.level) {
      checkpoint.phaseCompleted(ctx.runId, step.id, {})
      ctx = recordPhase(ctx, step.id, 'skipped')
      stepIndex++
      continue
    }

    // Cost check before worker steps
    if (step.type === 'worker' && costTracker.isOverBudget(ctx.runId, config.security)) {
      logger.warn({ runId: ctx.runId }, 'Cost limit exceeded')
      return recordPhase(
        updateContext(ctx, { currentPhase: 'blocked', terminalStatus: 'blocked' }),
        step.id,
        'failure',
      )
    }

    // Execute step
    const stepStart = Date.now()
    const stepStartedAt = utcIsoFromMs(stepStart)
    ctx = updateContext(ctx, { currentPhase: step.id })
    checkpoint.phaseStarted(ctx.runId, step.id)

    const result = await executeStep(ctx, step, stepDeps)
    ctx = result.ctx
    const stepDurationMs = Date.now() - stepStart

    // Cost tracking for worker steps
    if (step.type === 'worker') {
      ctx = applyEstimatedWorkerCost(ctx, costTracker, step.role, stepDurationMs, result.tokenUsage)
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
      checkpoint.phaseCompleted(ctx.runId, step.id, artifacts)
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
    checkpoint.phaseCompleted(ctx.runId, step.id, artifacts)
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
              return recordPhase(
                updateContext(ctx, { currentPhase: 'blocked', terminalStatus: 'blocked' }),
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
          ctx = updateContext(ctx, {
            iteration: ctx.iteration + 1,
            reviewFindings: [...ctx.reviewFindings, ...decision.findings],
            reviewResult: null,
            verifyResults: [],
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
            updateContext(ctx, { currentPhase: 'blocked', terminalStatus: 'blocked' }),
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
      return {}
    case 'verify':
      return { verifyResults: ctx.verifyResults }
    case 'decide':
      return {}
  }
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

const ESTIMATED_USD_PER_INPUT_TOKEN = 0.000003
const ESTIMATED_USD_PER_OUTPUT_TOKEN = 0.000015

const ESTIMATED_USD_PER_MINUTE: Record<string, number> = {
  planner: 0.008,
  coder: 0.008,
  reviewer: 0.008,
}

function applyEstimatedWorkerCost(
  ctx: RunContext,
  costTracker: CostTracker,
  role: string,
  durationMs: number,
  tokenUsage?: { promptTokens: number; completionTokens: number },
): RunContext {
  let estimatedCost: number
  if (tokenUsage) {
    estimatedCost = Number((
      tokenUsage.promptTokens * ESTIMATED_USD_PER_INPUT_TOKEN +
      tokenUsage.completionTokens * ESTIMATED_USD_PER_OUTPUT_TOKEN
    ).toFixed(6))
  } else {
    const rate = ESTIMATED_USD_PER_MINUTE[role] ?? 0.008
    estimatedCost = Number(((durationMs / 60_000) * rate).toFixed(6))
  }
  estimatedCost = Math.max(0, estimatedCost)
  if (estimatedCost <= 0) return ctx
  costTracker.recordCost(ctx.runId, estimatedCost)
  return updateContext(ctx, {
    estimatedCostUsd: Number((ctx.estimatedCostUsd + estimatedCost).toFixed(6)),
  })
}
