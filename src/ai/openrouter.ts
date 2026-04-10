import type { ZodSchema } from 'zod'
import type { AiClient, AiRequest, AiResponse } from './types.js'
import {
  AiAuthError,
  AiInvalidResponseError,
  AiRateLimitError,
  AiTransientError,
} from './errors.js'
import { extractAndValidateJson } from './json-extract.js'

/**
 * OpenRouter client using the OpenAI-compatible chat completions
 * endpoint. Works for any provider OpenRouter proxies (Anthropic
 * models, Google, Mistral, local ollama via the OpenAI proxy), so
 * it doubles as a fallback for operators who don't want a separate
 * Anthropic account.
 *
 * Hand-rolled HTTP fetch instead of the `openai` SDK for the same
 * reason as the Anthropic client: the internal AI layer does
 * stateless single-turn completions and the SDK's value-add (tool
 * calling, streaming, assistants) is outside this scope.
 *
 * Reference: https://openrouter.ai/docs/api-reference
 */

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 1024

interface OpenRouterChoice {
  message?: { role?: string; content?: string }
  finish_reason?: string
}

interface OpenRouterUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

interface OpenRouterResponse {
  id: string
  model: string
  choices: OpenRouterChoice[]
  usage: OpenRouterUsage
}

export class OpenRouterClient implements AiClient {
  readonly provider = 'openrouter' as const

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
      response = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          // OpenRouter asks clients to identify themselves so
          // usage can be attributed; the headers are optional but
          // show up on the dashboard.
          'x-title': 'night-orch',
          'http-referer': 'https://github.com/shllg/night-orch',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: req.temperature ?? 0,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
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

    let parsed: OpenRouterResponse
    try {
      parsed = (await response.json()) as OpenRouterResponse
    } catch (err) {
      throw new AiInvalidResponseError(
        this.provider,
        this.model,
        `response body was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const choice = parsed.choices?.[0]
    const content = choice?.message?.content
    if (!content) {
      throw new AiInvalidResponseError(
        this.provider,
        this.model,
        'response contained no choice content',
        JSON.stringify(parsed),
      )
    }

    return {
      text: content,
      resolvedModel: parsed.model ?? this.model,
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: {
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
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
    const snippet = body.slice(0, 500)
    if (status === 401 || status === 403) {
      throw new AiAuthError(this.provider, this.model, `HTTP ${status}: ${snippet}`)
    }
    if (status === 429) {
      throw new AiRateLimitError(this.provider, this.model, `HTTP 429: ${snippet}`)
    }
    if (status >= 500 && status < 600) {
      throw new AiTransientError(this.provider, this.model, `HTTP ${status}: ${snippet}`, status)
    }
    throw new AiTransientError(this.provider, this.model, `HTTP ${status}: ${snippet}`, status)
  }
}

function mapFinishReason(raw: string | undefined): AiResponse['finishReason'] {
  if (raw === 'length') return 'length'
  if (raw === 'stop' || raw === 'end_turn' || raw === undefined) return 'stop'
  return 'stop'
}
