import type { RunContext, LoopDecision } from './types.js'
import type { WorkflowStep, WorkerStep, VerifyStep, DecideStep } from './workflow.js'
import type { WorkerAdapter, WorkerTaskInput, PromptContext, WorkerTaskResult } from '../workers/types.js'
import type { Config } from '../config/schema.js'
import type { MetricsService } from '../metrics/service.js'
import type { AgentEvent } from '../events/types.js'
import { updateContext } from './context.js'
import { decide } from './decision.js'
import { runVerifyCommands } from './verifier.js'
import { compilePrompt } from '../workers/prompt/compiler.js'
import { getDefaultTemplate, buildPlanningOnlyCoderTemplate } from '../workers/prompt/templates.js'
import { buildWorkerEnv, buildVerifierEnv } from '../workers/env.js'
import { getDiffAgainstBranch, getChangedFilesAgainstBranch } from '../git/repo.js'
import { superviseWorker } from './supervisor.js'
import {
  WorkerAuthError,
  WorkerTimeoutError,
  WorkerTransientError,
} from '../workers/errors.js'
import { getRemediation } from '../workers/auth-check.js'
import { logger } from '../utils/logger.js'
import { buildPlanningPrdPath, isPlanningIssue } from '../planning/mode.js'

export interface StepDependencies {
  adapters: Record<string, WorkerAdapter>
  config: Config
  envOverrides?: Record<string, string>
  metrics?: MetricsService
  onAgentEvent?: (event: AgentEvent) => void
}

export interface StepResult {
  ctx: RunContext
  tokenUsage?: WorkerTaskResult['tokenUsage']
  pricingIdentity?: {
    role: string
    workerType: string
    pricingModel: string | null
    fallbackMinuteUsd: number | null
  }
  /** For decide steps: the decision action. */
  decision?: LoopDecision
}

/**
 * Dispatch a workflow step to the appropriate executor based on step type.
 */
export async function executeStep(
  ctx: RunContext,
  step: WorkflowStep,
  deps: StepDependencies,
): Promise<StepResult> {
  switch (step.type) {
    case 'worker':
      return executeWorkerStep(ctx, step, deps)
    case 'verify':
      return executeVerifyStep(ctx, step, deps)
    case 'decide':
      return executeDecideStep(ctx, step, deps)
  }
}

/**
 * Execute a worker step: resolve adapter, compile prompt, run with supervision,
 * parse output, and populate the appropriate RunContext fields.
 */
export async function executeWorkerStep(
  ctx: RunContext,
  step: WorkerStep,
  deps: StepDependencies,
): Promise<StepResult> {
  const adapter = resolveAdapter(step.role, ctx, deps)
  const profile = getWorkerProfile(ctx, step.role, deps)
  const promptCtx = buildPromptContext(ctx, step.role)
  let template = step.prompt ?? getDefaultTemplate(step.role)
  if (!step.prompt && step.role === 'coder' && isPlanningIssue(ctx.issue.labels, ctx.repoConfig)) {
    const prdPath = buildPlanningPrdPath(ctx.issueNumber, ctx.issue.title, ctx.repoConfig)
    template = buildPlanningOnlyCoderTemplate(prdPath)
  }
  const { systemPrompt, userPrompt } = compilePrompt(
    null,
    template,
    promptCtx,
  )

  const env = buildWorkerEnv(profile, deps.envOverrides)
  const continueSessionId = resolveContinueSession(ctx, step, profile.type)

  const supervisor = superviseWorker(step.role, ctx.adjustedLimits.workerTimeoutSeconds * 1000, () => {
    // Advisory — the timeout.ts layer handles actual SIGTERM
  })

  let result: WorkerTaskResult
  const start = Date.now()
  try {
    result = await adapter.runTask({
      runId: ctx.runId,
      phase: step.id,
      role: step.role as WorkerTaskInput['role'],
      worktreePath: ctx.worktreePath,
      prompt: `${systemPrompt}\n\n${userPrompt}`,
      profile,
      timeoutSeconds: ctx.adjustedLimits.workerTimeoutSeconds,
      env,
      onEvent: deps.onAgentEvent,
      continueSessionId,
    })
    supervisor.cancel()
  } catch (err) {
    supervisor.cancel()
    throw err
  }

  try {
    const adapterType = profile.type === 'codex' ? 'codex' : 'claude' as const
    const knownRole = step.role as 'planner' | 'coder' | 'reviewer'
    deps.metrics?.incAgentInvocations(knownRole, adapterType)
    deps.metrics?.observeAgentDuration(step.role, adapterType, (Date.now() - start) / 1000)
  } catch { /* best-effort */ }

  const adapterType = profile.type === 'codex' ? 'codex' : 'claude'
  if (result.timedOut) {
    const timeoutMs = ctx.adjustedLimits.workerTimeoutSeconds * 1000
    logger.error(
      { role: step.role, adapterType, timeoutMs },
      `${step.role} worker timed out`,
    )
    throw new WorkerTimeoutError(adapterType, step.id, timeoutMs)
  }
  if (result.exitCode !== 0) {
    if (result.authFailure) {
      logger.error(
        { role: step.role, exitCode: result.exitCode, adapterType },
        `${step.role} worker authentication failure — CLI is signed out`,
      )
      throw new WorkerAuthError(
        adapterType,
        getRemediation(adapterType),
        `${step.role} worker exited with code ${result.exitCode} (authentication failure)`,
        step.id,
      )
    }
    logger.error(
      {
        role: step.role,
        exitCode: result.exitCode,
        rawLength: result.rawOutput.length,
        rawTail: result.rawOutput.slice(-500),
      },
      `${step.role} worker exited with non-zero code`,
    )
    throw new WorkerTransientError(
      adapterType,
      step.id,
      `worker exited with code ${result.exitCode}`,
    )
  }
  if (result.parseError) {
    logger.warn(
      { role: step.role, parseError: result.parseError, rawLength: result.rawOutput.length, rawHead: result.rawOutput.slice(0, 500), rawTail: result.rawOutput.slice(-500) },
      `${step.role} worker output parse failed`,
    )
  }

  // Map result to the appropriate RunContext field based on role
  const ctxPatch = buildWorkerCtxPatch(ctx, step, result, profile.type)
  let updatedCtx = updateContext(ctx, ctxPatch)

  // Coder fallback: if parse failed but worker exited 0, build synthetic
  // codeResult from git diff (the coder wrote files to disk).
  if (step.role === 'coder' && !updatedCtx.codeResult && result.exitCode === 0) {
    updatedCtx = await applyCoderDiffFallback(updatedCtx)
  }

  return {
    ctx: updatedCtx,
    tokenUsage: result.tokenUsage,
    pricingIdentity: {
      role: step.role,
      workerType: profile.type,
      pricingModel: profile.pricingModel ?? null,
      fallbackMinuteUsd: profile.minuteUsd ?? null,
    },
  }
}

/**
 * Execute a verify step: run verify commands and populate ctx.verifyResults and ctx.diff.
 */
export async function executeVerifyStep(
  ctx: RunContext,
  _step: VerifyStep,
  deps: StepDependencies,
): Promise<StepResult> {
  const verifyResults = await runVerifyCommands(
    ctx.worktreePath,
    ctx.repoConfig.verify,
    buildVerifierEnv(deps.envOverrides),
  )

  // Verify metrics (duration + pass/fail) are recorded by the engine
  // after this step completes — recording here would double-count.

  const diffResult = await getDiffAgainstBranch(ctx.worktreePath, ctx.repoConfig.baseBranch)

  return {
    ctx: updateContext(ctx, {
      verifyResults,
      diff: diffResult.diff,
      diffError: diffResult.error,
    }),
  }
}

/**
 * Execute a decide step: call decide() and return the decision in StepResult.
 */
export async function executeDecideStep(
  ctx: RunContext,
  step: DecideStep,
  deps: StepDependencies,
): Promise<StepResult> {
  const decision = decide(ctx, deps.config.loop, deps.config.security, {
    requireReview: step.requireReview,
    costModel: deps.config.cost?.model ?? 'pay-per-use',
  })
  return { ctx, decision }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the correct worker adapter for a role, using repo agent mapping. */
function resolveAdapter(
  role: string,
  ctx: RunContext,
  deps: StepDependencies,
): WorkerAdapter {
  // First, try a direct match on role name in the adapters map
  const direct = deps.adapters[role]
  if (direct) return direct

  // Next, try resolving through the roles → agents mapping
  const agentName = ctx.roles[role as keyof typeof ctx.roles]
  if (agentName) {
    const viaAgent = deps.adapters[agentName]
    if (viaAgent) return viaAgent
  }

  throw new Error(`No worker adapter found for role "${role}"`)
}

/**
 * Build a PromptContext from RunContext for a given role.
 * Mirrors the engine.ts version but accepts any string role.
 */
export function buildPromptContext(ctx: RunContext, role: string): PromptContext {
  const followup = parseFollowupContext(ctx.prReviewFeedback)
  return {
    role: role as PromptContext['role'],
    issue: {
      number: ctx.issueNumber,
      title: ctx.issue.title,
      body: ctx.issue.body,
      labels: ctx.issue.labels,
    },
    repo: {
      name: ctx.repo,
      baseBranch: ctx.repoConfig.baseBranch,
    },
    plan: ctx.plan?.objective ?? null,
    diff: ctx.diff ?? null,
    reviewFindings: ctx.reviewFindings.length > 0 ? ctx.reviewFindings : null,
    verifyResults: ctx.verifyResults.length > 0 ? ctx.verifyResults : null,
    iteration: {
      current: ctx.iteration,
      max: ctx.adjustedLimits.maxReviewIterations,
      isRetry: ctx.iteration > 1,
    },
    triageLevel: ctx.triageResult.level,
    followup,
    emptyDiffRetry: ctx.emptyDiffRetries > 0,
  }
}

function parseFollowupContext(value: unknown): PromptContext['followup'] {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>

  const context = candidate['context']
  if (typeof context !== 'string' || context.trim().length === 0) return null

  const type = typeof candidate['type'] === 'string' && candidate['type'].trim().length > 0
    ? candidate['type']
    : 'continue'
  const summary = typeof candidate['summary'] === 'string' && candidate['summary'].trim().length > 0
    ? candidate['summary']
    : null

  return { type, summary, context }
}

/**
 * Resolve the worker profile configuration for a role.
 * Uses the repo's agent mapping to look up the profile in config.workerProfiles.
 */
export function getWorkerProfile(
  ctx: RunContext,
  role: string,
  deps: StepDependencies,
) {
  // Try role → agent name → profile name chain
  const agentName = ctx.roles[role as keyof typeof ctx.roles]
  if (agentName) {
    const profileName = ctx.repoConfig.agents[agentName]
    if (profileName) {
      const profile = deps.config.workerProfiles[profileName]
      if (profile) return profile
    }
  }

  // Fallback: find first profile whose type matches the agent name
  const targetType = agentName ?? role
  const fallback = Object.values(deps.config.workerProfiles).find((p) => p.type === targetType)
  if (fallback) return fallback

  throw new Error(`No worker profile found for role "${role}" (agent: ${agentName ?? 'unknown'})`)
}

/**
 * Determine which session to continue for a workflow step.
 * Uses step.continueFrom to find the session ID of a prior step's role.
 */
export function resolveContinueSession(ctx: RunContext, step: WorkerStep, profileType: string): string | null {
  if (!step.continueFrom) return null

  const scopedStepSession = ctx.sessionIds[sessionScopeKey(step.continueFrom, profileType)]
  if (scopedStepSession) return scopedStepSession

  // continueFrom references a workflow step ID.
  // Backward-compatibility: older checkpoints keyed by default role names.
  const legacyRoleAlias = STEP_ID_TO_DEFAULT_ROLE[step.continueFrom]
  if (legacyRoleAlias) {
    const scopedLegacySession = ctx.sessionIds[sessionScopeKey(legacyRoleAlias, profileType)]
    if (scopedLegacySession) return scopedLegacySession
  }

  // Only reuse unscoped continueFrom sessions when source/current roles use the same agent.
  if (isUntypedContinueAllowed(ctx, step)) {
    const sessionId = ctx.sessionIds[step.continueFrom]
    if (sessionId) return sessionId

    if (legacyRoleAlias) {
      const legacySession = ctx.sessionIds[legacyRoleAlias]
      if (legacySession) return legacySession
    }
  }

  // On iteration 2+, also try this step's own prior session.
  if (ctx.iteration > 1) {
    const ownSession = ctx.sessionIds[sessionScopeKey(step.id, profileType)]
      ?? ctx.sessionIds[sessionScopeKey(step.role, profileType)]
      ?? ctx.sessionIds[step.id]
      ?? ctx.sessionIds[step.role]
    if (ownSession) return ownSession
  }

  return null
}

function isUntypedContinueAllowed(ctx: RunContext, step: WorkerStep): boolean {
  if (!step.continueFrom) return false
  if (!isBuiltInRole(step.role)) return true

  const sourceRole = resolveContinueSourceRole(step.continueFrom)
  if (!sourceRole) return true

  return ctx.roles[sourceRole] === ctx.roles[step.role]
}

function resolveContinueSourceRole(continueFrom: string): keyof RunContext['roles'] | null {
  if (isBuiltInRole(continueFrom)) return continueFrom
  const legacyRoleAlias = STEP_ID_TO_DEFAULT_ROLE[continueFrom]
  return isBuiltInRole(legacyRoleAlias) ? legacyRoleAlias : null
}

function isBuiltInRole(role: string | undefined): role is keyof RunContext['roles'] {
  return role === 'planner' || role === 'coder' || role === 'reviewer'
}

function sessionScopeKey(id: string, profileType: string): string {
  return `${id}::${profileType}`
}

const STEP_ID_TO_DEFAULT_ROLE: Record<string, string> = {
  plan: 'planner',
  code: 'coder',
  review: 'reviewer',
}

/**
 * Build the RunContext patch for a completed worker step, mapping parsed
 * output to the correct context field based on the step's role.
 */
function buildWorkerCtxPatch(
  ctx: RunContext,
  step: WorkerStep,
  result: WorkerTaskResult,
  profileType: string,
): Partial<RunContext> {
  const basePatch: Partial<RunContext> = {
    totalAgentPasses: ctx.totalAgentPasses + 1,
    sessionIds: result.sessionId
      ? {
          ...ctx.sessionIds,
          [step.id]: result.sessionId,
          [step.role]: result.sessionId,
          [sessionScopeKey(step.id, profileType)]: result.sessionId,
          [sessionScopeKey(step.role, profileType)]: result.sessionId,
        }
      : ctx.sessionIds,
    stepOutputs: { ...ctx.stepOutputs, [step.id]: result.parsed },
  }

  switch (step.role) {
    case 'planner':
      return { ...basePatch, plan: result.parsed as RunContext['plan'] }

    case 'coder':
      return { ...basePatch, codeResult: result.parsed as RunContext['codeResult'] }

    case 'reviewer':
      return { ...basePatch, reviewResult: result.parsed as RunContext['reviewResult'] }

    default:
      // Custom roles: only populate stepOutputs (already in basePatch)
      return basePatch
  }
}

/**
 * Apply the git-diff fallback for coder steps where parse failed but the
 * worker exited successfully. Called after buildWorkerCtxPatch for coder role.
 */
async function applyCoderDiffFallback(ctx: RunContext): Promise<RunContext> {
  if (ctx.codeResult) return ctx

  logger.info({ runId: ctx.runId }, 'Coder parse failed — falling back to git diff for changed files')
  const changedFiles = await getChangedFilesAgainstBranch(ctx.worktreePath, ctx.repoConfig.baseBranch)
  if (changedFiles.length > 0) {
    return updateContext(ctx, {
      codeResult: {
        summary: 'Coder output could not be parsed. Changed files detected via git diff.',
        changedFiles,
        remainingUncertainty: 'Coder structured output was not parseable — review carefully.',
        blockers: null,
      },
    })
  }
  return ctx
}

// Re-export prompt templates from their canonical location under
// workers/prompt/ (rule 00-core: "Keep prompt logic in workers/prompt/").
export {
  DEFAULT_PLANNER_TEMPLATE,
  DEFAULT_CODER_TEMPLATE,
  DEFAULT_REVIEWER_TEMPLATE,
  buildPlanningOnlyCoderTemplate,
  getDefaultTemplate,
} from '../workers/prompt/templates.js'
