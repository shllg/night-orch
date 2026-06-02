import type { MCPDependencies } from '../server.js'
import { listHandoffs } from '../../state/handoffs.js'
import { RunManager } from '../../state/runs.js'

const MAX_HANDOFFS = 200

export async function handleHandoffs(args: { runId: string }, deps: MCPDependencies): Promise<unknown> {
  const runManager = new RunManager(deps.db)
  const run = runManager.getById(args.runId)
  if (!run) throw new Error(`Run not found: ${args.runId}`)

  const rows = listHandoffs(deps.db, args.runId)
  const handoffs = rows.slice(0, MAX_HANDOFFS).map((handoff) => ({
    id: handoff.id,
    runId: handoff.runId,
    attemptId: handoff.attemptId,
    stepId: handoff.stepId,
    fromRole: handoff.fromRole,
    toRole: handoff.toRole,
    kind: handoff.kind,
    summary: handoff.summary,
    contentMd: handoff.contentMd,
    contentJson: handoff.contentJson,
    tokenUsage: handoff.tokenUsage,
    createdAt: handoff.createdAt.toISOString(),
  }))

  return {
    runId: args.runId,
    count: handoffs.length,
    total: rows.length,
    truncated: rows.length > MAX_HANDOFFS,
    handoffs,
  }
}
