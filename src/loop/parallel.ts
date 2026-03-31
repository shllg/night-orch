import type { SubTask } from '../workers/parsers/decomposer.js'
import type { RunContext } from './types.js'
import type { LoopDependencies } from './engine.js'
import { executeLoop } from './engine.js'
import { RunManager } from '../state/runs.js'
import { createWorktreeManager } from '../git/worktree.js'
import { buildWorktreePath } from '../git/slug.js'
import { logger } from '../utils/logger.js'

export interface SubTaskResult {
  index: number
  subtask: SubTask
  ctx: RunContext | null
  success: boolean
  error?: string
}

/**
 * Topological sort into waves: tasks in the same wave have no
 * inter-dependencies and can run concurrently.
 */
export function topologicalWaves(subtasks: SubTask[]): number[][] {
  if (subtasks.length === 0) return []

  const depths = new Array<number>(subtasks.length).fill(0)

  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < subtasks.length; i++) {
      const task = subtasks[i]!
      for (const dep of task.dependencies) {
        if (dep >= 0 && dep < subtasks.length) {
          const newDepth = (depths[dep] ?? 0) + 1
          if (newDepth > (depths[i] ?? 0)) {
            depths[i] = newDepth
            changed = true
          }
        }
      }
    }
  }

  const maxDepth = Math.max(...depths)
  const waves: number[][] = []
  for (let d = 0; d <= maxDepth; d++) {
    const wave: number[] = []
    for (let i = 0; i < depths.length; i++) {
      if (depths[i] === d) wave.push(i)
    }
    if (wave.length > 0) waves.push(wave)
  }

  return waves
}

/**
 * Execute subtasks in parallel waves, each in its own worktree.
 */
export async function executeParallelSubtasks(
  parentCtx: RunContext,
  subtasks: SubTask[],
  deps: LoopDependencies,
  maxConcurrent: number,
): Promise<SubTaskResult[]> {
  const waves = topologicalWaves(subtasks)
  const results: SubTaskResult[] = []
  const runManager = new RunManager(deps.db)
  const worktreeManager = createWorktreeManager()

  for (const wave of waves) {
    const chunks = chunkArray(wave, maxConcurrent)

    for (const chunk of chunks) {
      const promises = chunk.map(async (index) => {
        const subtask = subtasks[index]!
        const subBranch = `${parentCtx.branchName}-sub${index}`
        const subWorktreePath = buildWorktreePath(
          parentCtx.worktreePath + '-subs',
          parentCtx.repo,
          parentCtx.issueNumber * 100 + index,
        )

        try {
          const subRun = runManager.create({
            repo: parentCtx.repo,
            issueNumber: parentCtx.issueNumber,
            issueNodeId: parentCtx.issue.nodeId,
            planner: parentCtx.roles.planner,
            coder: parentCtx.roles.coder,
            reviewer: parentCtx.roles.reviewer,
            parentRunId: parentCtx.runId,
          })

          await worktreeManager.ensure({
            repoLocalPath: parentCtx.repoConfig.localPath,
            baseBranch: parentCtx.repoConfig.baseBranch,
            branchName: subBranch,
            worktreePath: subWorktreePath,
            resetToBase: true,
          })

          const subCtx: RunContext = {
            ...parentCtx,
            runId: subRun.id,
            branchName: subBranch,
            worktreePath: subWorktreePath,
            plan: null,
            codeResult: null,
            diff: null,
            verifyResults: [],
            reviewResult: null,
            reviewFindings: [],
            iteration: 1,
            totalAgentPasses: 0,
            estimatedCostUsd: 0,
            currentPhase: 'plan',
            terminalStatus: 'running',
            phaseHistory: [],
            sessionIds: {},
            stepOutputs: {},
            issue: {
              ...parentCtx.issue,
              title: subtask.title,
              body: subtask.description,
            },
          }

          runManager.update(subRun.id, { status: 'running', branchName: subBranch, worktreePath: subWorktreePath })

          const finalCtx = await executeLoop(subCtx, deps)
          const success = finalCtx.terminalStatus === 'publish'

          runManager.update(subRun.id, {
            status: success ? 'review_ready' : 'blocked',
            endedAt: new Date().toISOString(),
          })

          return { index, subtask, ctx: finalCtx, success }
        } catch (err) {
          logger.error({ index, title: subtask.title, err }, 'Sub-task execution failed')
          return { index, subtask, ctx: null, success: false, error: String(err) }
        }
      })

      const waveResults = await Promise.allSettled(promises)
      for (const settled of waveResults) {
        if (settled.status === 'fulfilled') {
          results.push(settled.value)
        } else {
          logger.error({ err: settled.reason }, 'Sub-task promise rejected unexpectedly')
        }
      }
    }
  }

  return results
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}
