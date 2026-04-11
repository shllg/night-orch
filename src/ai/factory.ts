import type { Config } from '../config/schema.js'
import type { AiClient } from './types.js'
import { AnthropicClient } from './anthropic.js'
import { OpenRouterClient } from './openrouter.js'
import { OpenAiClient } from './openai.js'
import { logger } from '../utils/logger.js'

/**
 * Build an `AiClient` from the `ai.internal` config block, or
 * return `null` when the layer isn't configured.
 *
 * Returns `null` (and logs a warning) rather than throwing when:
 *  - Provider/model/apiKeyEnv are not set (intentional — layer is
 *    off and every consumer falls through to its pre-Phase-3
 *    behavior)
 *  - The configured `apiKeyEnv` var is missing from the
 *    environment (operator has enabled a feature but didn't export
 *    the key; the per-feature consumer should skip gracefully
 *    rather than block every run)
 *
 * Throws only for programmer errors (invalid provider value, which
 * the schema validation should catch first).
 */
export function createAiClient(config: Config): AiClient | null {
  const { internal } = config.ai

  if (!internal.provider || !internal.model || !internal.apiKeyEnv) {
    return null
  }

  const apiKey = process.env[internal.apiKeyEnv]
  if (!apiKey) {
    logger.warn(
      { apiKeyEnv: internal.apiKeyEnv, provider: internal.provider },
      'ai.internal.apiKeyEnv not set in environment — direct-LLM features disabled',
    )
    return null
  }

  switch (internal.provider) {
    case 'anthropic':
      return new AnthropicClient(internal.model, apiKey)
    case 'openrouter':
      return new OpenRouterClient(internal.model, apiKey)
    case 'openai':
      return new OpenAiClient(internal.model, apiKey)
    default: {
      const _exhaustive: never = internal.provider
      throw new Error(`Unknown ai.internal.provider: ${String(_exhaustive)}`)
    }
  }
}
