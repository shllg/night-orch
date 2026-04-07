import type { MCPDependencies } from '../server.js'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setIssueCostOverride } from '../../ops/cost-override.js'
import { setDailyCostCapOverride } from '../../ops/daily-cost-override.js'
import { LabelsInitEngine, formatLabelsInitSummary } from '../../ops/labels-init.js'
import { DeleteIssueEntryEngine } from '../../ops/delete-entry.js'
import { nowUtcIso } from '../../utils/time.js'
import { assertMcpMutationAuth } from './auth.js'

export async function handleCostOverride(
  args: { repo: string; issueNumber: number; amountUsd?: number; clear?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const clear = args.clear ?? false
  if (clear && args.amountUsd !== undefined) {
    throw new Error('cost-override: cannot pass amountUsd together with clear:true')
  }
  if (!clear && (typeof args.amountUsd !== 'number' || !Number.isFinite(args.amountUsd) || args.amountUsd <= 0)) {
    throw new Error('cost-override: amountUsd must be a positive finite number (or set clear:true to remove)')
  }
  const overrideUsd = clear ? null : (args.amountUsd as number)
  const result = setIssueCostOverride(deps.db, args.repo, args.issueNumber, overrideUsd)
  return {
    success: true,
    runId: result.runId,
    previousOverrideUsd: result.previousOverrideUsd,
    overrideUsd: result.overrideUsd,
    message:
      overrideUsd === null
        ? `Cleared cost override for ${args.repo}#${args.issueNumber} (run ${result.runId})`
        : `Set cost override for ${args.repo}#${args.issueNumber} (run ${result.runId}) to $${overrideUsd.toFixed(2)}; daily cap bypassed for this run.`,
  }
}

export async function handleDailyCostOverride(
  args: { amountUsd?: number; clear?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const clear = args.clear ?? false
  if (clear && args.amountUsd !== undefined) {
    throw new Error('daily-cost-override: cannot pass amountUsd together with clear:true')
  }
  if (!clear && (typeof args.amountUsd !== 'number' || !Number.isFinite(args.amountUsd) || args.amountUsd <= 0)) {
    throw new Error('daily-cost-override: amountUsd must be a positive finite number (or set clear:true to remove)')
  }
  const overrideUsd = clear ? null : (args.amountUsd as number)
  const result = setDailyCostCapOverride(deps.db, overrideUsd)
  return {
    success: true,
    date: result.date,
    previousUsd: result.previousUsd,
    overrideUsd: result.overrideUsd,
    message:
      overrideUsd === null
        ? `Cleared daily cost cap override for ${result.date}; base cap applies.`
        : `Set daily cost cap override for ${result.date} to $${overrideUsd.toFixed(2)}; auto-expires at 00:00 UTC.`,
  }
}

export async function handleLabelsInit(
  args: { repo: string; dryRun?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  if (!args.repo) {
    throw new Error('repo is required')
  }

  const engine = new LabelsInitEngine(deps.config)
  const result = await engine.run({
    targetRepo: args.repo,
    dryRun: args.dryRun ?? false,
  })

  return {
    ...result,
    message: formatLabelsInitSummary(result),
  }
}

export async function handleDeleteEntry(
  args: { repo: string; issueNumber: number; force?: boolean; dryRun?: boolean; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)
  const engine = new DeleteIssueEntryEngine(deps.db, deps.config)
  return engine.deleteEntry(args.repo, args.issueNumber, {
    dryRun: args.dryRun ?? false,
    force: args.force ?? false,
  })
}

export async function handleUpdate(
  args: { authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  // Try IPC first (running under supervisor)
  if (typeof process.send === 'function') {
    process.send({ type: 'update-requested' })
    return { accepted: true, method: 'ipc' }
  }

  // Fallback: trigger file
  const dataDir = resolve(homedir(), '.config', 'night-orch')
  const triggerPath = resolve(dataDir, 'update-requested')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(triggerPath, nowUtcIso())
  return { accepted: true, method: 'trigger-file' }
}
