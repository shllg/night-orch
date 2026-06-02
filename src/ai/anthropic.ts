import type { ZodSchema } from 'zod'
import type { AiClient, AiRequest, AiResponse } from './types.js'
import {
  AiAuthError,
  AiInvalidResponseError,
  AiRateLimitError,
  AiTransientError,
} from './errors.js'
import { extractAndValidateJson } from './json-extract.js'
import { sanitizeErrorMessage } from '../utils/sanitize-error.js'

/**
 * Hand-rolled Anthropic Messages API client.
 *
 * Uses `fetch` directly instead of `@anthropic-ai/sdk` to avoid a
 * new runtime dependency — the Messages API is a single POST
 * endpoint and the SDK's value-add (streaming, batching, tool-use)
 * isn't needed for the stateless classification / generation work
 * the internal AI layer does.
 *
 * Reference: https://docs.anthropic.com/en/api/messages
 */

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_API_VERSION = '2023-06-01'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 1024

interface AnthropicContentBlock {
  type: string
  text?: string
}

interface AnthropicResponse {
  id: string
  model: string
  content: AnthropicContentBlock[]
  stop_reason: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export class AnthropicClient implements AiClient {
  readonly provider = 'anthropic' as const

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: req.temperature ?? 0,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        }),
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AiTransientError(
          this.provider,
          this.model,
          `request timed out after ${timeoutMs}ms`,
        )
      }
      throw new AiTransientError(
        this.provider,
        this.model,
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      clearTimeout(timeoutHandle)
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      this.throwForStatus(response.status, bodyText)
    }

    let parsed: AnthropicResponse
    try {
      parsed = (await response.json()) as AnthropicResponse
    } catch (err) {
      throw new AiInvalidResponseError(
        this.provider,
        this.model,
        `response body was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const text = (parsed.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text ?? '')
      .join('')

    if (!text) {
      throw new AiInvalidResponseError(
        this.provider,
        this.model,
        'response contained no text content blocks',
        JSON.stringify(parsed),
      )
    }

    return {
      text,
      resolvedModel: parsed.model ?? this.model,
      finishReason: mapStopReason(parsed.stop_reason),
      usage: {
        promptTokens:
          (parsed.usage.input_tokens ?? 0) +
          (parsed.usage.cache_creation_input_tokens ?? 0),
        completionTokens: parsed.usage.output_tokens ?? 0,
        ...(parsed.usage.cache_read_input_tokens
          ? { cacheReadTokens: parsed.usage.cache_read_input_tokens }
          : {}),
      },
    }
  }

  async completeStructured<T>(req: AiRequest, schema: ZodSchema<T>): Promise<T> {
    const augmented: AiRequest = {
      ...req,
      system: `${req.system}\n\nReply with ONLY a JSON object. Do not wrap it in markdown code fences or add any prose.`,
    }
    const response = await this.complete(augmented)
    return extractAndValidateJson(response.text, schema, this.provider, this.model)
  }

  private throwForStatus(status: number, body: string): never {
    const snippet = sanitizeErrorMessage(body.slice(0, 500))
    if (status === 401 || status === 403) {
      throw new AiAuthError(this.provider, this.model, `HTTP ${status}: ${snippet}`)
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(body)
      throw new AiRateLimitError(
        this.provider,
        this.model,
        `HTTP 429: ${snippet}`,
        retryAfterMs,
      )
    }
    if (status >= 500 && status < 600) {
      throw new AiTransientError(this.provider, this.model, `HTTP ${status}: ${snippet}`, status)
    }
    throw new AiTransientError(this.provider, this.model, `HTTP ${status}: ${snippet}`, status)
  }
}

function mapStopReason(raw: string | null): AiResponse['finishReason'] {
  if (raw === 'max_tokens') return 'length'
  if (raw === 'end_turn' || raw === 'stop_sequence') return 'stop'
  if (raw === null) return 'stop'
  return 'stop'
}

function parseRetryAfter(body: string): number | undefined {
  // Anthropic sometimes surfaces retry hints in the error body.
  // Fall back to undefined — callers shouldn't rely on this.
  try {
    const parsed = JSON.parse(body) as { error?: { retry_after?: number } }
    if (parsed.error && typeof parsed.error.retry_after === 'number') {
      return parsed.error.retry_after * 1000
    }
  } catch {
    // ignore
  }
  return undefined
}
