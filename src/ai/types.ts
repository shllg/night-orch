/**
 * Phase 3: direct-LLM API layer for night-orch's internal AI
 * tasks — triage classification, PR description generation, review
 * parse-failure salvage. NOT for code-editing work (planner, coder,
 * reviewer): those keep running on Claude Code / Codex / opencode
 * CLIs where the agentic tool-use loop and session-resume semantics
 * live.
 *
 * The AI layer exists because some night-orch-owned decisions are
 * pure text-to-structured-data transformations where spinning up a
 * CLI worker would be wasteful and the cost accounting gets more
 * reliable (we see every token directly from the API response
 * rather than parsing CLI stdout).
 *
 * Usage flows through the R4 cost ledger identically to CLI worker
 * usage, tagged `tokenSource: 'measured_api'` and
 * `workerType: 'internal-ai'` so reports can distinguish the two
 * funding sources.
 */

import type { ZodSchema } from 'zod'
import type { TokenUsage } from '../workers/types.js'

export type AiProvider = 'anthropic' | 'openrouter'

/**
 * Single request into the AI layer. `system` and `user` map to the
 * system prompt and the single user turn respectively — multi-turn
 * conversations aren't supported because every internal task is a
 * stateless classification or generation.
 */
export interface AiRequest {
  system: string
  user: string
  /** Max tokens the model is allowed to emit. Defaults per provider. */
  maxTokens?: number
  /** Sampling temperature. Defaults to 0 for deterministic outputs. */
  temperature?: number
  /** Overall request timeout in milliseconds. Defaults to 30s. */
  timeoutMs?: number
}

/**
 * Result of a successful AI call. `usage` reuses the same
 * `TokenUsage` shape that CLI workers emit so the cost recorder
 * doesn't need a second path.
 */
export interface AiResponse {
  text: string
  usage: TokenUsage
  finishReason: 'stop' | 'length' | 'error'
  /** Provider-reported model id; may differ from the requested id
   * when the provider silently substitutes (e.g. OpenRouter). */
  resolvedModel: string
}

export interface AiClient {
  readonly provider: AiProvider
  readonly model: string

  /** Plain text completion. Throws a typed `AiError` on failure. */
  complete(req: AiRequest): Promise<AiResponse>

  /**
   * Structured completion: wraps `complete` with a JSON-extraction
   * step. Asks the model to return JSON matching the provided
   * schema, extracts the first top-level JSON object from the
   * response, and validates via zod. Used for triage and the
   * reviewer parse fallback where we need typed data, not prose.
   */
  completeStructured<T>(req: AiRequest, schema: ZodSchema<T>): Promise<T>
}
