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
 * OpenAI client hitting the Chat Completions API directly. Same wire
 * format as the OpenRouter client because OpenRouter is OpenAI-compat,
 * but without the OpenRouter-specific attribution headers and pointed
 * at the canonical `api.openai.com` endpoint.
 *
 * Hand-rolled fetch rather than the `openai` SDK for the same reason
 * as the other AI clients — stateless single-turn completions only;
 * the SDK's tool-calling / streaming / assistants surface is out of
 * scope for the internal AI layer.
 *
 * Reference: https://platform.openai.com/docs/api-reference/chat
 */

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TOKENS = 1024

interface OpenAiChoice {
  message?: { role?: string; content?: string }
  finish_reason?: string
}

interface OpenAiUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

interface OpenAiResponse {
  id: string
  model: string
  choices: OpenAiChoice[]
  usage: OpenAiUsage
}

export class OpenAiClient implements AiClient {
  readonly provider = 'openai' as const

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
      response = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
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

    let parsed: OpenAiResponse
    try {
      parsed = (await response.json()) as OpenAiResponse
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
    const snippet = sanitizeErrorMessage(body.slice(0, 500))
    if (status === 401 || status === 403) {
      throw new AiAuthError(this.provider, this.model, `HTTP ${status}: ${snippet}`)
    }
    if (status === 404) {
      // OpenAI returns 404 when the requested model id doesn't exist
      // for the account. Treat as invalid-response so the doctor
      // probe and log output name the slug as the likely culprit.
      throw new AiInvalidResponseError(
        this.provider,
        this.model,
        `HTTP 404: ${snippet}`,
        sanitizeErrorMessage(body),
      )
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
