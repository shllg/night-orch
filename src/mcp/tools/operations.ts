import type { MCPDependencies } from '../server.js'
import { RetryEngine } from '../../ops/retry.js'
import { SyncEngine } from '../../ops/sync.js'
import { CleanupEngine } from '../../ops/cleanup.js'
import { queueContinue } from '../../ops/continue.js'
import { createForgeAdapter } from '../../forge/factory.js'
import { pollOnce } from '../../runner/poller.js'
import { assertMcpMutationAuth } from './auth.js'

export async function handleRetry(
  args: { repo: string; issueNumber: number; resetPlan?: boolean; fresh?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const fresh = args.fresh ?? false
  const engine = new RetryEngine(deps.db, deps.config)
  await engine.retry(args.repo, args.issueNumber, {
    resetPlan: args.resetPlan ?? fresh,
    resetBranch: fresh,
    dryRun: false,
    immediate: false,
  })
  const suffix = fresh ? ' (fresh start — branch will be reset)' : ''
  return { success: true, message: `Retry queued for ${args.repo}#${args.issueNumber}${suffix}` }
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
  args: { repo: string; issueNumber: number; check?: boolean; authToken?: string },
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
  const result = await queueRebase(deps.db, forge, repoConfig, args.issueNumber, botUser)

  return {
    queued: result.queued,
    reason: result.reason,
  }
}

export async function handleContinue(
  args: { repo: string; issueNumber: number; authToken?: string },
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

  const result = await queueContinue(deps.db, forge, repoConfig, args.issueNumber, botUser)

  return {
    queued: result.queued,
    reason: result.reason,
  }
}
