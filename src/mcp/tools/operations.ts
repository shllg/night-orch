import type { MCPDependencies } from '../server.js'
import type { UpdateStrategy } from '../../git/worktree.js'
import type { ExternalPollTriggerResult, ManualPollTriggerResult } from '../../poller/control.js'
import { requestExternalPollCycle } from '../../poller/control.js'
import { RetryEngine } from '../../ops/retry.js'
import { SyncEngine } from '../../ops/sync.js'
import { CleanupEngine } from '../../ops/cleanup.js'
import { queueContinue } from '../../ops/continue.js'
import { createForgeAdapter } from '../../forge/factory.js'
import { pollOnce } from '../../runner/poller.js'
import { assertMcpMutationAuth } from './auth.js'

export async function handleRetry(
  args: {
    repo: string
    issueNumber: number
    resetPlan?: boolean
    fresh?: boolean
    strategy?: UpdateStrategy
    authToken?: string
  },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const engine = new RetryEngine(deps.db, deps.config)
  await engine.retry(args.repo, args.issueNumber, {
    resetPlan: true,
    resetBranch: true,
    dryRun: false,
    immediate: false,
    strategyOverride: args.strategy,
    actor: 'mcp',
  })
  const trigger = triggerPoller(deps)
  return {
    success: true,
    message: `Fresh retry queued for ${args.repo}#${args.issueNumber}`,
    ...(trigger ? { pollTrigger: trigger } : {}),
  }
}

export async function handleSync(args: { dryRun?: boolean; authToken?: string }, deps: MCPDependencies): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const engine = new SyncEngine(deps.db, deps.config)
  return engine.reconcile(args.dryRun ?? false)
}

export async function handleCleanup(args: { dryRun?: boolean; authToken?: string }, deps: MCPDependencies): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const engine = new CleanupEngine(deps.db, deps.config)
  return engine.run({ dryRun: args.dryRun ?? false })
}

export async function handlePoll(
  args: { dryRun?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  if (deps.poller && !(args.dryRun ?? false)) {
    const trigger = deps.poller.triggerPollCycle()
    return {
      success: true,
      queued: true,
      state: trigger.state,
      processed: null,
      errors: null,
      message: trigger.state === 'woke-sleeper'
        ? 'Triggered immediate poll cycle on running headless poller'
        : trigger.state === 'queued-next-cycle'
          ? 'Queued immediate poll cycle after current run finishes'
          : 'Manual poll already pending; no additional cycle queued',
    }
  }

  const result = await pollOnce(deps.config, deps.db, args.dryRun ?? false)
  return {
    success: true,
    processed: result.processed,
    errors: result.errors,
    message: result.processed === 0
      ? 'No eligible issues found'
      : `Processed ${result.processed} issue(s), ${result.errors} error(s)`,
  }
}

export async function handleRebase(
  args: { repo: string; issueNumber: number; check?: boolean; strategy?: UpdateStrategy; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  const repoConfig = deps.config.repos.find((r) => r.repo === args.repo)
  if (!repoConfig) throw new Error(`Repository not found: ${args.repo}`)

  const forge = createForgeAdapter(repoConfig, deps.config)
  let botUser = ''
  try {
    const auth = await forge.validateAuth()
    botUser = auth.user
  } catch { /* best effort */ }

  const { queueRebase } = await import('../../ops/rebase-and-check.js')
  const result = await queueRebase(deps.db, forge, repoConfig, args.issueNumber, botUser, {
    check: args.check,
    strategyOverride: args.strategy,
    actor: 'mcp',
    maxAttemptChainLength: deps.config.loop.maxAttemptChainLength,
  })
  const trigger = result.queued ? triggerPoller(deps) : null

  return {
    queued: result.queued,
    reason: result.reason,
    ...(trigger ? { pollTrigger: trigger } : {}),
  }
}

export async function handleContinue(
  args: { repo: string; issueNumber: number; strategy?: UpdateStrategy; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  const repoConfig = deps.config.repos.find((r) => r.repo === args.repo)
  if (!repoConfig) throw new Error(`Repository not found: ${args.repo}`)

  const forge = createForgeAdapter(repoConfig, deps.config)
  let botUser = ''
  try {
    const auth = await forge.validateAuth()
    botUser = auth.user
  } catch { /* best effort */ }

  const result = await queueContinue(deps.db, forge, repoConfig, args.issueNumber, botUser, {
    strategyOverride: args.strategy,
    actor: 'mcp',
    maxAttemptChainLength: deps.config.loop.maxAttemptChainLength,
  })
  const trigger = result.queued ? triggerPoller(deps) : null

  return {
    queued: result.queued,
    reason: result.reason,
    ...(trigger ? { pollTrigger: trigger } : {}),
  }
}

function triggerPoller(
  deps: MCPDependencies,
): ManualPollTriggerResult | ExternalPollTriggerResult {
  if (deps.poller) {
    return deps.poller.triggerPollCycle()
  }

  return requestExternalPollCycle(deps.config.storage.dbPath)
}
