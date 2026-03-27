import type { RunContext, LoopPhase } from './types.js'
import type { Config } from '../config/schema.js'
import type { WorkerAdapter, PromptContext, WorkerTaskResult } from '../workers/types.js'
import type { MetricsService } from '../metrics/service.js'
import { updateContext, recordPhase } from './context.js'
import { decide } from './decision.js'
import { runVerifyCommands, allVerifyPassed } from './verifier.js'
import { commitChanges } from './commit.js'
import { compilePrompt } from '../workers/prompt/compiler.js'
import { buildWorkerEnv, buildVerifierEnv } from '../workers/env.js'
import { Checkpoint } from './checkpoint.js'
import { CostTracker } from './cost.js'
import { getDiffAgainstBranch, getChangedFilesAgainstBranch } from '../git/repo.js'
import { logger } from '../utils/logger.js'
import type Database from 'better-sqlite3'

export interface LoopDependencies {
  db: Database.Database
  config: Config
  plannerAdapter: WorkerAdapter
  coderAdapter: WorkerAdapter
  reviewerAdapter: WorkerAdapter
  envOverrides?: Record<string, string>
  metrics?: MetricsService
  onPlanReady?: (ctx: RunContext) => Promise<void>
}

/**
 * Execute the full Plan → Code → Verify → Review loop.
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

  // PLAN
  ctx = updateContext(ctx, { currentPhase: 'plan' as LoopPhase })
  checkpoint.phaseStarted(ctx.runId, 'plan')

  if (ctx.triageResult.level !== 'trivial') {
    const planStart = Date.now()
    const planStartedAt = new Date(planStart).toISOString()
    ctx = await runPlanStep(ctx, deps)
    const planDurationMs = Date.now() - planStart
    ctx = applyEstimatedWorkerCost(ctx, costTracker, 'planner', planDurationMs)
    try { metrics?.observePhaseDuration('plan', planDurationMs / 1000) } catch { /* best-effort */ }
    checkpoint.phaseCompleted(ctx.runId, 'plan', { plan: ctx.plan })

    if (!ctx.plan && config.loop.stopOnPlannerFailure) {
      logger.error({ runId: ctx.runId }, 'Planner failed and stopOnPlannerFailure is true')
      return recordPhase(
        updateContext(ctx, { currentPhase: 'error', terminalStatus: 'error' }),
        'plan',
        'failure',
        {},
        planStartedAt,
      )
    }
  } else {
    checkpoint.phaseCompleted(ctx.runId, 'plan', {})
    ctx = recordPhase(ctx, 'plan', 'skipped')
    logger.info({ runId: ctx.runId }, 'Trivial issue — skipping planning')
  }

  if (ctx.plan && deps.onPlanReady) {
    try {
      await deps.onPlanReady(ctx)
    } catch (err) {
      logger.warn({ runId: ctx.runId, repo: ctx.repo, issueNumber: ctx.issueNumber, err }, 'Failed to post plan summary')
    }
  }

  // ITERATION LOOP
  while (true) {
    // Cost check
    if (costTracker.isOverBudget(ctx.runId, config.security)) {
      logger.warn({ runId: ctx.runId }, 'Cost limit exceeded')
      return recordPhase(
        updateContext(ctx, { currentPhase: 'blocked', terminalStatus: 'blocked' }),
        'code',
        'failure',
      )
    }

    // CODE
    const codeStart = Date.now()
    const codeStartedAt = new Date(codeStart).toISOString()
    ctx = updateContext(ctx, { currentPhase: 'code' as LoopPhase })
    checkpoint.phaseStarted(ctx.runId, 'code')
    ctx = await runCodeStep(ctx, deps)
    const codeDurationMs = Date.now() - codeStart
    ctx = applyEstimatedWorkerCost(ctx, costTracker, 'coder', codeDurationMs)
    try { metrics?.observePhaseDuration('code', codeDurationMs / 1000) } catch { /* best-effort */ }
    checkpoint.phaseCompleted(ctx.runId, 'code', { codeResult: ctx.codeResult })
    ctx = recordPhase(ctx, 'code', ctx.codeResult ? 'success' : 'failure', {}, codeStartedAt)

    // VERIFY
    const verifyStart = Date.now()
    const verifyStartedAt = new Date(verifyStart).toISOString()
    ctx = updateContext(ctx, { currentPhase: 'verify' as LoopPhase })
    checkpoint.phaseStarted(ctx.runId, 'verify')
    const verifyResults = await runVerifyCommands(
      ctx.worktreePath,
      ctx.repoConfig.verify,
      buildVerifierEnv(deps.envOverrides),
    )
    const verifyDurationMs = Date.now() - verifyStart
    try {
      metrics?.observePhaseDuration('verify', verifyDurationMs / 1000)
      metrics?.observeVerifyDuration(verifyDurationMs / 1000)
      metrics?.incVerifyRuns(allVerifyPassed(verifyResults) ? 'pass' : 'fail')
    } catch { /* best-effort */ }
    ctx = updateContext(ctx, { verifyResults })
    checkpoint.phaseCompleted(ctx.runId, 'verify', { verifyResults })
    ctx = recordPhase(
      ctx,
      'verify',
      allVerifyPassed(verifyResults) ? 'success' : 'failure',
      {},
      verifyStartedAt,
    )

    // Fetch diff against target branch for the reviewer
    const diff = await getDiffAgainstBranch(ctx.worktreePath, ctx.repoConfig.baseBranch)
    ctx = updateContext(ctx, { diff })

    // REVIEW
    const reviewStart = Date.now()
    const reviewStartedAt = new Date(reviewStart).toISOString()
    ctx = updateContext(ctx, { currentPhase: 'review' as LoopPhase })
    checkpoint.phaseStarted(ctx.runId, 'review')
    ctx = await runReviewStep(ctx, deps)
    const reviewDurationMs = Date.now() - reviewStart
    ctx = applyEstimatedWorkerCost(ctx, costTracker, 'reviewer', reviewDurationMs)
    try { metrics?.observePhaseDuration('review', reviewDurationMs / 1000) } catch { /* best-effort */ }
    checkpoint.phaseCompleted(ctx.runId, 'review', { reviewResult: ctx.reviewResult })
    ctx = recordPhase(ctx, 'review', ctx.reviewResult ? 'success' : 'failure', {}, reviewStartedAt)

    // DECISION
    const decision = decide(ctx, config.loop, config.security)
    logger.info({ runId: ctx.runId, decision: decision.action, reason: decision.reason }, 'Loop decision')

    switch (decision.action) {
      case 'publish': {
        // Commit changes
        const commitResult = await commitChanges(
          ctx.worktreePath,
          ctx.issueNumber,
          ctx.issue.title,
          config.security,
        )
        if (!commitResult.committed) {
          logger.warn({ reason: commitResult.reason }, 'Commit skipped')
          if (commitResult.reason?.startsWith('Diff-size guard')) {
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
          totalAgentPasses: ctx.totalAgentPasses + 1,
          reviewFindings: [...ctx.reviewFindings, ...decision.findings],
          reviewResult: null,
          verifyResults: [],
        })
        try { metrics?.incLoopIterations(ctx.repo) } catch { /* best-effort */ }
        logger.info(
          { runId: ctx.runId, iteration: ctx.iteration },
          'Iterating loop',
        )
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
}

const ESTIMATED_USD_PER_MINUTE: Record<'planner' | 'coder' | 'reviewer', number> = {
  planner: 0.008,
  coder: 0.008,
  reviewer: 0.008,
}

function applyEstimatedWorkerCost(
  ctx: RunContext,
  costTracker: CostTracker,
  role: 'planner' | 'coder' | 'reviewer',
  durationMs: number,
): RunContext {
  const rate = ESTIMATED_USD_PER_MINUTE[role]
  const estimatedCost = Math.max(0, Number(((durationMs / 60_000) * rate).toFixed(6)))
  if (estimatedCost <= 0) return ctx
  costTracker.recordCost(ctx.runId, estimatedCost)
  return updateContext(ctx, {
    estimatedCostUsd: Number((ctx.estimatedCostUsd + estimatedCost).toFixed(6)),
  })
}

async function runPlanStep(ctx: RunContext, deps: LoopDependencies): Promise<RunContext> {
  const result = await runWorkerStep(
    ctx,
    deps,
    'planner',
    deps.plannerAdapter,
    ctx.repoConfig.prompts?.plannerSystem,
    DEFAULT_PLANNER_TEMPLATE,
  )

  return updateContext(ctx, {
    plan: result.parsed as RunContext['plan'],
    totalAgentPasses: ctx.totalAgentPasses + 1,
  })
}

async function runCodeStep(ctx: RunContext, deps: LoopDependencies): Promise<RunContext> {
  const result = await runWorkerStep(
    ctx,
    deps,
    'coder',
    deps.coderAdapter,
    ctx.repoConfig.prompts?.coderSystem,
    DEFAULT_CODER_TEMPLATE,
  )

  let codeResult = result.parsed as RunContext['codeResult']

  // Fallback: if parse failed but coder exited successfully, build a synthetic
  // codeResult from git. The coder wrote files to disk — we just couldn't parse
  // its structured output.
  if (!codeResult && result.exitCode === 0) {
    logger.info({ runId: ctx.runId }, 'Coder parse failed — falling back to git diff for changed files')
    const changedFiles = await getChangedFilesAgainstBranch(ctx.worktreePath, ctx.repoConfig.baseBranch)
    if (changedFiles.length > 0) {
      codeResult = {
        summary: 'Coder output could not be parsed. Changed files detected via git diff.',
        changedFiles,
        remainingUncertainty: 'Coder structured output was not parseable — review carefully.',
        blockers: null,
      }
    }
  }

  return updateContext(ctx, {
    codeResult,
    totalAgentPasses: ctx.totalAgentPasses + 1,
  })
}

async function runReviewStep(ctx: RunContext, deps: LoopDependencies): Promise<RunContext> {
  const result = await runWorkerStep(
    ctx,
    deps,
    'reviewer',
    deps.reviewerAdapter,
    ctx.repoConfig.prompts?.reviewerSystem,
    DEFAULT_REVIEWER_TEMPLATE,
  )

  return updateContext(ctx, {
    reviewResult: result.parsed as RunContext['reviewResult'],
    totalAgentPasses: ctx.totalAgentPasses + 1,
  })
}

async function runWorkerStep(
  ctx: RunContext,
  deps: LoopDependencies,
  role: 'planner' | 'coder' | 'reviewer',
  adapter: WorkerAdapter,
  customTemplate: string | undefined,
  defaultTemplate: string,
): Promise<WorkerTaskResult> {
  const promptCtx = buildPromptContext(ctx, role)
  const { systemPrompt, userPrompt } = compilePrompt(
    customTemplate ?? null,
    defaultTemplate,
    promptCtx,
  )

  const profile = getWorkerProfile(ctx, role, deps.config)
  const env = buildWorkerEnv(profile, deps.envOverrides)
  const start = Date.now()
  const result = await adapter.runTask({
    role,
    worktreePath: ctx.worktreePath,
    prompt: `${systemPrompt}\n\n${userPrompt}`,
    profile,
    timeoutSeconds: ctx.adjustedLimits.workerTimeoutSeconds,
    env,
  })

  try {
    const adapterType = profile.type === 'codex' ? 'codex' : 'claude'
    deps.metrics?.incAgentInvocations(role, adapterType)
    deps.metrics?.observeAgentDuration(role, adapterType, (Date.now() - start) / 1000)
  } catch { /* best-effort */ }

  if (result.timedOut) {
    throw new Error(`${role} worker timed out after ${ctx.adjustedLimits.workerTimeoutSeconds}s`)
  }
  if (result.exitCode !== 0) {
    logger.error({ role, exitCode: result.exitCode, rawLength: result.rawOutput.length, rawTail: result.rawOutput.slice(-500) }, `${role} worker exited with non-zero code`)
    throw new Error(`${role} worker exited with code ${result.exitCode}`)
  }
  if (result.parseError) {
    logger.warn({ role, parseError: result.parseError, rawLength: result.rawOutput.length, rawHead: result.rawOutput.slice(0, 500), rawTail: result.rawOutput.slice(-500) }, `${role} worker output parse failed`)
  }

  return result
}

function buildPromptContext(ctx: RunContext, role: 'planner' | 'coder' | 'reviewer'): PromptContext {
  return {
    role,
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
  }
}

function getWorkerProfile(ctx: RunContext, role: 'planner' | 'coder' | 'reviewer', config: Config) {
  const agentName = ctx.roles[role]
  const profileName = ctx.repoConfig.agents[agentName]
  if (profileName && config.workerProfiles[profileName]) {
    return config.workerProfiles[profileName]
  }
  // Fallback to first profile of the matching type
  const fallback = Object.values(config.workerProfiles).find((p) => p.type === agentName)
  if (fallback) return fallback
  throw new Error(`No worker profile found for agent "${agentName}" (role: ${role})`)
}

const DEFAULT_PLANNER_TEMPLATE = `You are a software planning assistant. Create a thorough, evidence-based implementation plan.

## Phase 1: Codebase Exploration

Explore the codebase to understand the project before planning:
- Read the project structure and key configuration files
- Find and read files relevant to the issue
- Identify existing patterns, conventions, and utilities that should be reused
- Understand dependencies and how components interact

Use tools freely: Read files, search with Glob/Grep, run read-only commands.

IMPORTANT: The branch may contain commits from prior attempts at this issue. Do NOT assume prior work is complete or correct. Evaluate what exists: check if it compiles, passes tests, and fully addresses the issue. Then plan what remains — whether that is finishing incomplete work, fixing broken work, or starting fresh.

## Phase 2: Implementation Plan

After exploring, produce your plan as a JSON block. Reference actual files and patterns you found.

\`\`\`json
{
  "objective": "One sentence describing the goal",
  "assumptions": ["List assumptions about the codebase"],
  "filesToChange": ["src/path/to/file.ts"],
  "steps": [{"order": 1, "description": "What to do", "files": ["src/path/to/file.ts"]}],
  "risks": ["Potential issues"],
  "testStrategy": "How to verify the changes work"
}
\`\`\`

CRITICAL: Your response MUST end with exactly one \\\`\\\`\\\`json block containing your plan. This JSON block is the LAST thing in your response.`

const DEFAULT_CODER_TEMPLATE = `You are a software implementation assistant. Implement the changes described in the plan.

After making changes, output a summary as JSON:
\`\`\`json
{
  "summary": "...",
  "changedFiles": ["..."],
  "remainingUncertainty": null,
  "blockers": null
}
\`\`\``

const DEFAULT_REVIEWER_TEMPLATE = `You are a code reviewer. Perform a thorough, evidence-based review of the changes.

## Phase 1: Context Gathering

Before reviewing, understand what changed and why:
- Read the changed files IN FULL (not just the diff) to understand context
- Check related tests and verify they cover the changes
- Read adjacent code to verify the changes follow existing patterns
- Check for security concerns, error handling, and edge cases

Use tools freely: Read files, search with Glob/Grep, run read-only commands.

## Phase 2: Review Verdict

After thorough analysis, produce your review as a JSON block. Reference specific files and lines in your findings.

\`\`\`json
{
  "verdict": "APPROVED or CHANGES_REQUIRED or BLOCKED",
  "summary": "Brief review summary",
  "findings": [{"severity": "critical or major or minor", "message": "What's wrong", "suggestedFix": "How to fix it"}],
  "definitionOfDoneCheck": {"issueAddressed": true, "testsPassing": true, "noBlockingFindings": true}
}
\`\`\`

CRITICAL: Your response MUST end with exactly one \\\`\\\`\\\`json block containing your review. This JSON block is the LAST thing in your response.`
