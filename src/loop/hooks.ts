import type { Config } from '../config/schema.js'
import type { WorkerStep } from './workflow.js'
import type { RunContext } from './types.js'
import { checkWorktreeScope } from './diff-guard.js'
import { logger } from '../utils/logger.js'

export interface WorkerHookBlock {
  blockReason: 'verify_config'
  blockMessage: string
}

type PostWorkerHook = (
  ctx: RunContext,
  step: WorkerStep,
  config: Config,
) => Promise<WorkerHookBlock | null>

const POST_WORKER_HOOKS: readonly PostWorkerHook[] = [
  checkCoderWorktreeScopeHook,
]

/**
 * Run hook checks immediately after a worker step succeeds and cost is
 * recorded, before verify/review phases run.
 */
export async function runPostWorkerHooks(
  ctx: RunContext,
  step: WorkerStep,
  config: Config,
): Promise<WorkerHookBlock | null> {
  const results = await Promise.allSettled(
    POST_WORKER_HOOKS.map((hook) => hook(ctx, step, config)),
  )

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn({ runId: ctx.runId, phase: step.id, err: result.reason }, 'Post-worker hook failed — continuing')
      continue
    }
    if (result.value) return result.value
  }

  return null
}

async function checkCoderWorktreeScopeHook(
  ctx: RunContext,
  step: WorkerStep,
  config: Config,
): Promise<WorkerHookBlock | null> {
  if (step.role !== 'coder') return null

  // Plan-time scope guard: block over-scoped coder output before
  // spending verify + review on it.
  const scope = await checkWorktreeScope(ctx.worktreePath, config.security)
  if (scope.ok) return null

  const blockMessage = `Scope guard: ${scope.reason}`
  logger.warn(
    { runId: ctx.runId, phase: step.id, stats: scope.stats },
    'Scope guard tripped after coder step — blocking before review',
  )

  return {
    blockReason: 'verify_config',
    blockMessage,
  }
}
