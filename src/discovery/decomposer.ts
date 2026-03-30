import type { ForgeIssue } from '../forge/types.js'
import type { WorkerAdapter, WorkerProfileInput } from '../workers/types.js'
import { parseDecomposerOutput, type DecompositionResult } from '../workers/parsers/decomposer.js'
import { logger } from '../utils/logger.js'

const BODY_LENGTH_THRESHOLD = 500
const NUMBERED_ITEM_PATTERN = /^\s*\d+[.)]\s+/gm
const HEADING_PATTERN = /^#{1,3}\s+/gm

export function shouldAttemptDecompose(issue: ForgeIssue): boolean {
  if (issue.body.trim().length >= BODY_LENGTH_THRESHOLD) return true
  const numberedItems = issue.body.match(NUMBERED_ITEM_PATTERN)
  if (numberedItems && numberedItems.length >= 3) return true
  const headings = issue.body.match(HEADING_PATTERN)
  if (headings && headings.length >= 3) return true
  return false
}

export async function decomposeIssue(
  issue: ForgeIssue,
  adapter: WorkerAdapter,
  profile: WorkerProfileInput,
  env: Record<string, string>,
  worktreePath: string,
  maxSubtasks: number,
): Promise<DecompositionResult> {
  const noDecompose: DecompositionResult = {
    shouldDecompose: false,
    subtasks: [],
    reasoning: 'Decomposition skipped or failed',
  }

  try {
    const result = await adapter.runTask({
      role: 'planner',
      worktreePath,
      prompt: buildDecomposePrompt(issue),
      profile,
      timeoutSeconds: Math.min(profile.workerTimeoutSeconds, 300),
      env,
    })

    if (result.exitCode !== 0 || result.timedOut) {
      logger.warn({ issueNumber: issue.number, exitCode: result.exitCode, timedOut: result.timedOut }, 'Decomposer worker failed')
      return noDecompose
    }

    const { result: parsed, error } = parseDecomposerOutput(result.rawOutput, maxSubtasks)
    if (error) {
      logger.info({ issueNumber: issue.number, error }, 'Decomposer parse note')
    }
    return parsed ?? noDecompose
  } catch (err) {
    logger.warn({ issueNumber: issue.number, err }, 'Decomposer failed — proceeding without decomposition')
    return noDecompose
  }
}

function buildDecomposePrompt(issue: ForgeIssue): string {
  return `You are a task decomposition assistant. Analyze this issue and determine if it should be split into smaller, independent sub-tasks.

## Issue #${issue.number}: ${issue.title}

${issue.body}

## Instructions

1. Decide if this issue should be decomposed (some issues are already atomic — that's fine)
2. If yes, split into 2-5 atomic sub-tasks that can be implemented independently
3. Each sub-task should be completable in a single coding session
4. Specify dependencies between sub-tasks (by index)

Output your analysis as JSON:

\`\`\`json
{
  "shouldDecompose": true,
  "reasoning": "Why this issue should/shouldn't be split",
  "subtasks": [
    {
      "title": "Short title",
      "description": "What to implement",
      "dependencies": [],
      "estimatedComplexity": "standard"
    }
  ]
}
\`\`\`

CRITICAL: Your response MUST end with exactly one \`\`\`json block.`
}
