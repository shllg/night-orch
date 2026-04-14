import type { Config } from '../config/schema.js'
import type { CostTracker } from '../loop/cost.js'
import { withLedger } from '../ai/ledger.js'
import { createAiClient } from '../ai/factory.js'
import { logger } from '../utils/logger.js'
import { buildResolverPrompt } from '../workers/prompt/resolver-prompt.js'
import type {
  ConflictResolutionContext,
  ConflictResolver,
  ConflictResolverInvocation,
  ConflictResolverResult,
  FullConflictSource,
} from './conflict-types.js'

interface CreateConflictResolverOptions {
  config: Config
  costTracker?: CostTracker
  runId?: string
}

export function createConflictResolver(
  options: CreateConflictResolverOptions,
): ConflictResolver | null {
  const ai = createAiClient(options.config)
  if (!ai) return null

  const trackedAi = options.costTracker && options.runId
    ? withLedger(ai, options.costTracker, () => ({
        runId: options.runId ?? null,
        stepId: 'rebase-conflict-resolver',
        workerType: 'internal-ai-conflict-resolver',
      }))
    : ai

  const maxAttempts = options.config.autoResolveConflicts.maxAttempts
  const maxFiles = options.config.autoResolveConflicts.maxFiles

  return {
    maxAttempts,
    maxFiles,
    async resolveConflicts(
      sources: FullConflictSource[],
      context: ConflictResolutionContext,
      invocation: ConflictResolverInvocation,
    ): Promise<ConflictResolverResult> {
      if (sources.length === 0) {
        return {
          ok: false,
          outcome: 'unresolved',
          reason: 'No unmerged files were available for resolution',
        }
      }

      if (sources.length > maxFiles) {
        return {
          ok: false,
          outcome: 'unresolved',
          reason: `Conflict spans ${sources.length} files which exceeds maxFiles=${maxFiles}`,
        }
      }

      const resolvedFiles: Array<{ path: string; resolved: string }> = []

      for (const source of sources) {
        try {
          const prompt = buildResolverPrompt(source, context)
          const response = await trackedAi.complete({
            system: prompt.system,
            user: prompt.user,
            maxTokens: options.config.ai.internal.maxTokens,
            temperature: 0,
            timeoutMs: options.config.ai.internal.timeoutMs,
          })
          const resolved = unwrapCodeFence(response.text)
          resolvedFiles.push({ path: source.path, resolved })
        } catch (err) {
          logger.warn(
            {
              repo: invocation.repo,
              issue: invocation.issueNumber,
              attempt: invocation.attempt,
              path: source.path,
              err,
            },
            'Conflict resolver request failed',
          )
          return {
            ok: false,
            outcome: 'error',
            reason: err instanceof Error ? err.message : String(err),
            files: resolvedFiles.map((file) => file.path),
          }
        }
      }

      return {
        ok: true,
        files: resolvedFiles,
      }
    },
  }
}

function unwrapCodeFence(value: string): string {
  const trimmed = value.trim()
  const fenceMatch = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/)
  if (fenceMatch) {
    return fenceMatch[1] ?? ''
  }
  return value
}
