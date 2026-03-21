import type { RunContext, LoopPhase } from './types.js'
import type { Config } from '../config/schema.js'
import type { WorkerAdapter, PromptContext } from '../workers/types.js'
import type { MetricsService } from '../metrics/service.js'
import { updateContext, recordPhase } from './context.js'
import { decide } from './decision.js'
import { runVerifyCommands, allVerifyPassed } from './verifier.js'
import { commitChanges } from './commit.js'
import { compilePrompt } from '../workers/prompt/compiler.js'
import { buildWorkerEnv } from '../workers/env.js'
import { Checkpoint } from './checkpoint.js'
import { CostTracker } from './cost.js'
import { logger } from '../utils/logger.js'
import type Database from 'better-sqlite3'

export interface LoopDependencies {
  db: Database.Database
  config: Config
  plannerAdapter: WorkerAdapter
  coderAdapter: WorkerAdapter
  reviewerAdapter: WorkerAdapter
  metrics?: MetricsService
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

  let ctx = initialCtx

  // PLAN
  ctx = updateContext(ctx, { currentPhase: 'plan' as LoopPhase })
  checkpoint.phaseStarted(ctx.runId, 'plan')

  if (ctx.triageResult.level !== 'trivial') {
    const planStart = Date.now()
    ctx = await runPlanStep(ctx, deps)
    try { metrics?.observePhaseDuration('plan', (Date.now() - planStart) / 1000) } catch { /* best-effort */ }
    checkpoint.phaseCompleted(ctx.runId, 'plan', { plan: ctx.plan })

    if (!ctx.plan && config.loop.stopOnPlannerFailure) {
      logger.error({ runId: ctx.runId }, 'Planner failed and stopOnPlannerFailure is true')
      return recordPhase(updateContext(ctx, { currentPhase: 'error' }), 'plan', 'failure')
    }
  } else {
    checkpoint.phaseCompleted(ctx.runId, 'plan', {})
    ctx = recordPhase(ctx, 'plan', 'skipped')
    logger.info({ runId: ctx.runId }, 'Trivial issue — skipping planning')
  }

  // ITERATION LOOP
  while (true) {
    // Cost check
    if (costTracker.isOverBudget(ctx.runId, config.security)) {
      logger.warn({ runId: ctx.runId }, 'Cost limit exceeded')
      return recordPhase(updateContext(ctx, { currentPhase: 'blocked' }), 'code', 'failure')
    }

    // CODE
    ctx = updateContext(ctx, { currentPhase: 'code' as LoopPhase })
    checkpoint.phaseStarted(ctx.runId, 'code')
    const codeStart = Date.now()
    ctx = await runCodeStep(ctx, deps)
    try { metrics?.observePhaseDuration('code', (Date.now() - codeStart) / 1000) } catch { /* best-effort */ }
    checkpoint.phaseCompleted(ctx.runId, 'code', { codeResult: ctx.codeResult })
    ctx = recordPhase(ctx, 'code', ctx.codeResult ? 'success' : 'failure')

    // VERIFY
    ctx = updateContext(ctx, { currentPhase: 'verify' as LoopPhase })
    checkpoint.phaseStarted(ctx.runId, 'verify')
    const verifyStart = Date.now()
    const verifyResults = await runVerifyCommands(ctx.worktreePath, ctx.repoConfig.verify)
    try {
      metrics?.observePhaseDuration('verify', (Date.now() - verifyStart) / 1000)
      metrics?.observeVerifyDuration((Date.now() - verifyStart) / 1000)
      metrics?.incVerifyRuns(allVerifyPassed(verifyResults) ? 'pass' : 'fail')
    } catch { /* best-effort */ }
    ctx = updateContext(ctx, { verifyResults })
    checkpoint.phaseCompleted(ctx.runId, 'verify', { verifyResults })
    ctx = recordPhase(ctx, 'verify', allVerifyPassed(verifyResults) ? 'success' : 'failure')

    // REVIEW
    ctx = updateContext(ctx, { currentPhase: 'review' as LoopPhase })
    checkpoint.phaseStarted(ctx.runId, 'review')
    const reviewStart = Date.now()
    ctx = await runReviewStep(ctx, deps)
    try { metrics?.observePhaseDuration('review', (Date.now() - reviewStart) / 1000) } catch { /* best-effort */ }
    checkpoint.phaseCompleted(ctx.runId, 'review', { reviewResult: ctx.reviewResult })
    ctx = recordPhase(ctx, 'review', ctx.reviewResult ? 'success' : 'failure')

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
            return recordPhase(updateContext(ctx, { currentPhase: 'blocked' }), 'publish', 'failure')
          }
        }
        return recordPhase(updateContext(ctx, { currentPhase: 'completed' }), 'publish', 'success')
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
        return recordPhase(updateContext(ctx, { currentPhase: 'blocked' }), 'decision', 'failure')

      case 'error':
        return recordPhase(updateContext(ctx, { currentPhase: 'error' }), 'decision', 'failure')
    }
  }
}

async function runPlanStep(ctx: RunContext, deps: LoopDependencies): Promise<RunContext> {
  const promptCtx = buildPromptContext(ctx, 'planner')
  const { systemPrompt, userPrompt } = compilePrompt(
    ctx.repoConfig.prompts?.plannerSystem ?? null,
    DEFAULT_PLANNER_TEMPLATE,
    promptCtx,
  )

  const profile = getWorkerProfile(ctx, 'planner', deps.config)
  const env = buildWorkerEnv(profile)
  const start = Date.now()
  const result = await deps.plannerAdapter.runTask({
    role: 'planner',
    worktreePath: ctx.worktreePath,
    prompt: `${systemPrompt}\n\n${userPrompt}`,
    profile,
    timeoutSeconds: ctx.adjustedLimits.workerTimeoutSeconds,
    env,
  })
  try {
    const adapter = profile.type === 'codex' ? 'codex' : 'claude'
    deps.metrics?.incAgentInvocations('planner', adapter)
    deps.metrics?.observeAgentDuration('planner', adapter, (Date.now() - start) / 1000)
  } catch { /* best-effort */ }

  return updateContext(ctx, {
    plan: result.parsed as RunContext['plan'],
    totalAgentPasses: ctx.totalAgentPasses + 1,
  })
}

async function runCodeStep(ctx: RunContext, deps: LoopDependencies): Promise<RunContext> {
  const promptCtx = buildPromptContext(ctx, 'coder')
  const { systemPrompt, userPrompt } = compilePrompt(
    ctx.repoConfig.prompts?.coderSystem ?? null,
    DEFAULT_CODER_TEMPLATE,
    promptCtx,
  )

  const profile = getWorkerProfile(ctx, 'coder', deps.config)
  const env = buildWorkerEnv(profile)
  const start = Date.now()
  const result = await deps.coderAdapter.runTask({
    role: 'coder',
    worktreePath: ctx.worktreePath,
    prompt: `${systemPrompt}\n\n${userPrompt}`,
    profile,
    timeoutSeconds: ctx.adjustedLimits.workerTimeoutSeconds,
    env,
  })
  try {
    const adapter = profile.type === 'codex' ? 'codex' : 'claude'
    deps.metrics?.incAgentInvocations('coder', adapter)
    deps.metrics?.observeAgentDuration('coder', adapter, (Date.now() - start) / 1000)
  } catch { /* best-effort */ }

  return updateContext(ctx, {
    codeResult: result.parsed as RunContext['codeResult'],
    totalAgentPasses: ctx.totalAgentPasses + 1,
  })
}

async function runReviewStep(ctx: RunContext, deps: LoopDependencies): Promise<RunContext> {
  const promptCtx = buildPromptContext(ctx, 'reviewer')
  const { systemPrompt, userPrompt } = compilePrompt(
    ctx.repoConfig.prompts?.reviewerSystem ?? null,
    DEFAULT_REVIEWER_TEMPLATE,
    promptCtx,
  )

  const profile = getWorkerProfile(ctx, 'reviewer', deps.config)
  const env = buildWorkerEnv(profile)
  const start = Date.now()
  const result = await deps.reviewerAdapter.runTask({
    role: 'reviewer',
    worktreePath: ctx.worktreePath,
    prompt: `${systemPrompt}\n\n${userPrompt}`,
    profile,
    timeoutSeconds: ctx.adjustedLimits.workerTimeoutSeconds,
    env,
  })
  try {
    const adapter = profile.type === 'codex' ? 'codex' : 'claude'
    deps.metrics?.incAgentInvocations('reviewer', adapter)
    deps.metrics?.observeAgentDuration('reviewer', adapter, (Date.now() - start) / 1000)
  } catch { /* best-effort */ }

  return updateContext(ctx, {
    reviewResult: result.parsed as RunContext['reviewResult'],
    totalAgentPasses: ctx.totalAgentPasses + 1,
  })
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

const DEFAULT_PLANNER_TEMPLATE = `You are a software planning assistant. Analyze the issue and create a detailed implementation plan.

Output your plan as a JSON block:
\`\`\`json
{
  "objective": "...",
  "assumptions": ["..."],
  "filesToChange": ["..."],
  "steps": [{"order": 1, "description": "...", "files": ["..."]}],
  "risks": ["..."],
  "testStrategy": "..."
}
\`\`\``

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

const DEFAULT_REVIEWER_TEMPLATE = `You are a code reviewer. Review the changes made for the issue.

Output your review as JSON:
\`\`\`json
{
  "verdict": "APPROVED" | "CHANGES_REQUIRED" | "BLOCKED",
  "summary": "...",
  "findings": [{"severity": "critical|major|minor", "message": "...", "suggestedFix": "..."}],
  "definitionOfDoneCheck": {"issueAddressed": true/false, "testsPassing": true/false, "noBlockingFindings": true/false}
}
\`\`\``
