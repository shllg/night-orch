import type { RunContext, LoopDecision } from './types.js'
import type { WorkflowStep, WorkerStep, VerifyStep, DecideStep } from './workflow.js'
import { reviewerKeyForStep } from './workflow.js'
import type {
  WorkerAdapter,
  WorkerTaskInput,
  PromptContext,
  WorkerTaskResult,
} from '../workers/types.js'
import type { Config } from '../config/schema.js'
import type { MetricsService } from '../metrics/service.js'
import type { AgentEvent } from '../events/types.js'
import { updateContext } from './context.js'
import { decide } from './decision.js'
import { allRequiredVerifyPassed, runVerifyCommands } from './verifier.js'
import { resolveVerifyCommands } from './verification-profile.js'
import { compilePrompt } from '../workers/prompt/compiler.js'
import { getDefaultTemplate, buildPlanningOnlyCoderTemplate } from '../workers/prompt/templates.js'
import { buildWorkerEnv, buildVerifierEnv } from '../workers/env.js'
import { getDiffAgainstBranch } from '../git/repo.js'
import { superviseWorker } from './supervisor.js'
import {
  WorkerAuthError,
  WorkerParseError,
  WorkerTimeoutError,
  WorkerTokenCaptureError,
  WorkerTransientError,
} from '../workers/errors.js'
import {
  CoderOutputContractSchema,
  PlannerOutputContractSchema,
  ReviewerOutputContractSchema,
} from '../workers/contracts.js'
import { createHash } from 'node:crypto'
import { getRemediation } from '../workers/auth-check.js'
import { logger } from '../utils/logger.js'
import { buildPlanningPrdPath, isPlanningIssue } from '../planning/mode.js'
import { recordPromptCompilation } from '../state/prompt-compilations.js'
import type Database from 'better-sqlite3'
import { coerceConflictSnapshot } from '../ops/conflict-types.js'
import { sanitizeErrorMessage } from '../utils/sanitize-error.js'
import { mergeReviewFindings, sourceReviewFindings } from './review-findings.js'
import type { z } from 'zod'

export interface StepDependencies {
  adapters: Record<string, WorkerAdapter>
  config: Config
  envOverrides?: Record<string, string>
  metrics?: MetricsService
  onAgentEvent?: (event: AgentEvent) => void
  /**
   * Optional SQLite handle for observability writes. When present and
   * `config.observability.recordPromptCompilations` is true, the worker
   * step records every compiled prompt into `prompt_compilations` for
   * retrospective mining (item 3). Optional so tests that don't exercise
   * the loop engine can omit it.
   */
  db?: Database.Database
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
  /**
   * Set when a coder worker completed but its output shows the workspace was
   * read-only (every write rejected). The engine records this step's cost as
   * normal, then blocks the run with an `environmentFault` reason instead of
   * burning the empty-diff retry budget on an unwritable environment. Value
   * is a short, non-sensitive rejection label.
   */
  environmentFault?: string
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

  recordPromptCompilationIfEnabled(deps, ctx, step, systemPrompt, userPrompt)

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
  // Detect an unwritable environment before the parse-error/token-capture
  // throws below, so a coder that hit a read-only sandbox is reported as an
  // environment fault (the real cause) rather than masked as a parse error.
  // The fault is carried out via StepResult — the engine records this step's
  // cost first, then blocks with `environmentFault` instead of spending the
  // empty-diff retry budget on an environment that will never become
  // writable mid-run (issue #341).
  const environmentFault = step.role === 'coder'
    ? detectReadOnlySandboxRejection(result.rawOutput)
    : null
  if (environmentFault) {
    const tokens = result.tokenUsage
    logger.error(
      {
        role: step.role,
        adapterType,
        rejection: environmentFault,
        promptTokens: tokens?.promptTokens ?? 0,
        completionTokens: tokens?.completionTokens ?? 0,
      },
      `${step.role} worker could not write to the workspace (read-only sandbox) — blocking instead of retrying`,
    )
    const faultedCtx = updateContext(ctx, buildWorkerCtxPatch(ctx, step, result, profile.type))
    return {
      ctx: faultedCtx,
      tokenUsage: result.tokenUsage,
      pricingIdentity: {
        role: step.role,
        workerType: profile.type,
        pricingModel: profile.pricingModel ?? null,
        fallbackMinuteUsd: profile.minuteUsd ?? null,
      },
      environmentFault,
    }
  }

  if (result.parseError) {
    logger.warn(
      { role: step.role, parseError: result.parseError, rawLength: result.rawOutput.length, rawHead: result.rawOutput.slice(0, 500), rawTail: result.rawOutput.slice(-500) },
      `${step.role} worker output parse failed`,
    )
    if (step.role === 'coder') {
      const rawOutputHash = `sha256:${createHash('sha256').update(result.rawOutput).digest('hex').slice(0, 16)}`
      throw new WorkerParseError(profile.type, step.id, rawOutputHash, result.parseError)
    }
  }

  // R4a: kill the silent duration-based cost fallback. Worker
  // invocations that complete (exit 0) but produce no parseable token
  // usage block the attempt unless the operator has explicitly set
  // `cost.allowEstimatedDuration: true` in config. The duration
  // estimate undercounted by 10-100× in production and was the root
  // cause of the "realistic cost measurement" issue. The block path
  // routes through R2's WorkerError catch in engine.ts, which maps
  // WorkerTokenCaptureError to a typed `tokenCaptureFailed` blocked
  // state.
  if (result.tokenUsage === undefined && deps.config.cost.allowEstimatedDuration !== true) {
    const rawOutputHash = `sha256:${createHash('sha256').update(result.rawOutput).digest('hex').slice(0, 16)}`
    logger.error(
      {
        role: step.role,
        adapterType,
        rawOutputLength: result.rawOutput.length,
        rawOutputHash,
      },
      `${step.role} worker produced no parseable token usage — blocking attempt`,
    )
    throw new WorkerTokenCaptureError(adapterType, step.id, rawOutputHash)
  }

  // Map result to the appropriate RunContext field based on role
  const ctxPatch = buildWorkerCtxPatch(ctx, step, result, profile.type)
  const updatedCtx = updateContext(ctx, ctxPatch)

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
  step: VerifyStep,
  deps: StepDependencies,
): Promise<StepResult> {
  const plannedCommands = resolveVerifyCommands(deps.config, ctx.repoConfig, step)
  const verifyResults = await runVerifyCommands(
    ctx.worktreePath,
    plannedCommands.map((entry) => entry.command),
    buildVerifierEnv(deps.envOverrides),
  )
  const stagedResults = verifyResults.map((result, index) => {
    const plan = plannedCommands[index]
    if (!plan) return result
    return {
      ...result,
      required: plan.required,
      stageId: plan.stageId,
      onFailure: plan.onFailure,
    }
  })

  // Verify metrics (duration + pass/fail) are recorded by the engine
  // after this step completes — recording here would double-count.

  const diffResult = await getDiffAgainstBranch(ctx.worktreePath, ctx.repoConfig.baseBranch)

  return {
    ctx: updateContext(ctx, {
      verifyResults: stagedResults,
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

export function determineStepSuccess(step: WorkflowStep, ctx: RunContext): boolean {
  switch (step.type) {
    case 'worker':
      if (step.role === 'planner') return ctx.plan !== null
      if (step.role === 'coder') return ctx.codeResult !== null
      if (step.role === 'reviewer') {
        const key = reviewerKeyForStep(step)
        return ctx.reviewResults[key] !== undefined
      }
      return true
    case 'verify':
      return ctx.verifyResults.length > 0 && allRequiredVerifyPassed(ctx.verifyResults)
    case 'decide':
      return true
  }
}

export function buildStepArtifacts(step: WorkflowStep, ctx: RunContext): Record<string, unknown> {
  switch (step.type) {
    case 'worker':
      if (step.role === 'planner') return { plan: ctx.plan }
      if (step.role === 'coder') return { codeResult: ctx.codeResult }
      if (step.role === 'reviewer') {
        const key = reviewerKeyForStep(step)
        const review = ctx.reviewResults[key] ?? null
        return {
          reviewerKey: key,
          reviewResults: review ? { [key]: review } : {},
        }
      }
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

/**
 * Scan backward from the verify step to find the nearest coder step.
 * Returns -1 if no coder step is found.
 */
export function findCoderStepBefore(steps: WorkflowStep[], verifyIndex: number): number {
  for (let i = verifyIndex - 1; i >= 0; i--) {
    const s = steps[i]!
    if (s.type === 'worker' && s.role === 'coder') return i
  }
  return -1
}

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
    reviewFindings: ctx.reviewFindings.length > 0 ? [...ctx.reviewFindings] : null,
    verifyResults: ctx.verifyResults.length > 0
      ? ctx.verifyResults.map((result) => ({
          ...result,
          stderr: sanitizeErrorMessage(result.stderr),
        }))
      : null,
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
  const conflictSnapshot = coerceConflictSnapshot(candidate['conflictSnapshot'])

  return { type, summary, context, conflictSnapshot }
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
/**
 * Read-only-sandbox rejection signatures emitted by Codex when a coder tries
 * to write in a read-only workspace. Matched only against *coder* output, so
 * a planner legitimately noting "read-only" never trips this. Returns a short
 * canonical label (never the raw output) for the blocked-state detail, or
 * `null` when no rejection is present.
 */
const READ_ONLY_SANDBOX_SIGNATURES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /writing is blocked by read-only sandbox/i, label: 'patch rejected: read-only sandbox' },
  { pattern: /patch rejected:[^\n]*read-only/i, label: 'patch rejected: read-only sandbox' },
  { pattern: /blocked by read-only sandbox/i, label: 'write blocked by read-only sandbox' },
  { pattern: /rejected by user approval settings/i, label: 'write rejected by approval settings' },
]

export function detectReadOnlySandboxRejection(rawOutput: string): string | null {
  if (!rawOutput) return null
  for (const { pattern, label } of READ_ONLY_SANDBOX_SIGNATURES) {
    if (pattern.test(rawOutput)) return label
  }
  return null
}

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
      return {
        ...basePatch,
        plan: parseWorkerOutputForRole(
          step,
          result,
          profileType,
          PlannerOutputContractSchema,
          'planner',
        ),
      }

    case 'coder':
      return {
        ...basePatch,
        codeResult: parseWorkerOutputForRole(
          step,
          result,
          profileType,
          CoderOutputContractSchema,
          'coder',
        ),
      }

    case 'reviewer':
      return buildReviewerCtxPatch(ctx, step, result, profileType, basePatch)

    default:
      // Custom roles: only populate stepOutputs (already in basePatch)
      return basePatch
  }
}

function buildReviewerCtxPatch(
  ctx: RunContext,
  step: WorkerStep,
  result: WorkerTaskResult,
  profileType: string,
  basePatch: Partial<RunContext>,
): Partial<RunContext> {
  const review = parseWorkerOutputForRole(
    step,
    result,
    profileType,
    ReviewerOutputContractSchema,
    'reviewer',
  )

  if (!review) {
    return {
      ...basePatch,
      reviewResults: {},
    }
  }

  const key = reviewerKeyForStep(step)
  const nextFindings = mergeReviewFindings(
    ctx.reviewFindings,
    sourceReviewFindings(review, key, step.role),
  )

  return {
    ...basePatch,
    reviewResults: {
      ...ctx.reviewResults,
      [key]: review,
    },
    reviewFindings: nextFindings,
  }
}

function recordPromptCompilationIfEnabled(
  deps: StepDependencies,
  ctx: RunContext,
  step: WorkerStep,
  systemPrompt: string,
  userPrompt: string,
): void {
  if (!deps.db) return
  if (!deps.config.observability?.recordPromptCompilations) return
  try {
    recordPromptCompilation(deps.db, {
      runId: ctx.runId,
      stepId: step.id,
      phase: step.id,
      templatePath: step.prompt ?? null,
      systemPrompt,
      userPrompt,
    })
  } catch (err) {
    // Best-effort observability — never block the loop on a write failure.
    logger.debug({ runId: ctx.runId, stepId: step.id, err }, 'Failed to record prompt compilation')
  }
}

function parseWorkerOutputForRole<T>(
  step: WorkerStep,
  result: WorkerTaskResult,
  profileType: string,
  schema: z.ZodType<T>,
  roleLabel: 'planner' | 'coder' | 'reviewer',
): T | null {
  if (result.parsed === null) {
    return null
  }

  const validation = schema.safeParse(result.parsed)
  if (validation.success) {
    return validation.data
  }

  const firstIssue = validation.error.issues[0]
  const issuePath = firstIssue?.path.join('.') || 'root'
  const rawOutputHash = `sha256:${createHash('sha256').update(result.rawOutput).digest('hex').slice(0, 16)}`
  throw new WorkerParseError(
    profileType,
    step.id,
    rawOutputHash,
    `${roleLabel} output failed contract validation at ${issuePath}`,
  )
}
