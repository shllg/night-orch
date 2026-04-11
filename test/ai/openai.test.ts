import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OpenAiClient } from '../../src/ai/openai.js'
import {
  AiAuthError,
  AiInvalidResponseError,
  AiRateLimitError,
  AiTransientError,
} from '../../src/ai/errors.js'

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

describe('OpenAiClient', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(response: Partial<Response> & { body: unknown }): void {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
        {
          status: response.status ?? 200,
          headers: response.headers,
        },
      ),
    ) as unknown as typeof fetch
  }

  describe('complete', () => {
    it('parses a successful response with usage', async () => {
      stubFetch({
        status: 200,
        body: {
          id: 'chatcmpl-abc',
          model: 'gpt-4o-mini',
          choices: [
            { message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        },
      })

      const client = new OpenAiClient('gpt-4o-mini', 'test-key')
      const result = await client.complete({ system: 's', user: 'u' })

      expect(result.text).toBe('hello world')
      expect(result.resolvedModel).toBe('gpt-4o-mini')
      expect(result.finishReason).toBe('stop')
      expect(result.usage.promptTokens).toBe(12)
      expect(result.usage.completionTokens).toBe(5)
    })

    it('maps length finish_reason', async () => {
      stubFetch({
        status: 200,
        body: {
          id: 'chatcmpl-abc',
          model: 'gpt-4o-mini',
          choices: [
            { message: { role: 'assistant', content: 'trunc' }, finish_reason: 'length' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1024, total_tokens: 1034 },
        },
      })
      const client = new OpenAiClient('gpt-4o-mini', 'test-key')
      const result = await client.complete({ system: 's', user: 'u' })
      expect(result.finishReason).toBe('length')
    })

    it('sends the expected request shape', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-abc',
            model: 'gpt-4o-mini',
            choices: [
              { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 },
        ),
      )
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const client = new OpenAiClient('gpt-4o-mini', 'sk-secret')
      await client.complete({
        system: 'be helpful',
        user: 'ping',
        temperature: 0.2,
        maxTokens: 16,
      })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(OPENAI_CHAT_URL)
      const headers = init.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer sk-secret')
      expect(headers['content-type']).toBe('application/json')
      const body = JSON.parse(init.body as string) as {
        model: string
        temperature: number
        max_tokens: number
        messages: Array<{ role: string; content: string }>
      }
      expect(body.model).toBe('gpt-4o-mini')
      expect(body.temperature).toBe(0.2)
      expect(body.max_tokens).toBe(16)
      expect(body.messages).toEqual([
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'ping' },
      ])
    })

    it('throws AiAuthError on 401', async () => {
      stubFetch({ status: 401, body: { error: { message: 'bad key' } } })
      const client = new OpenAiClient('gpt-4o-mini', 'bad')
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
        AiAuthError,
      )
    })

    it('throws AiInvalidResponseError on 404 (unknown model)', async () => {
      stubFetch({
        status: 404,
        body: { error: { message: 'model not found: gpt-9999' } },
      })
      const client = new OpenAiClient('gpt-9999', 'test-key')
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
        AiInvalidResponseError,
      )
    })

    it('throws AiRateLimitError on 429', async () => {
      stubFetch({ status: 429, body: { error: { message: 'slow down' } } })
      const client = new OpenAiClient('gpt-4o-mini', 'test-key')
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
        AiRateLimitError,
      )
    })

    it('throws AiTransientError on 5xx', async () => {
      stubFetch({ status: 503, body: { error: { message: 'overloaded' } } })
      const client = new OpenAiClient('gpt-4o-mini', 'test-key')
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
        AiTransientError,
      )
    })

    it('throws AiInvalidResponseError when response has no choices', async () => {
      stubFetch({
        status: 200,
        body: {
          id: 'chatcmpl-abc',
          model: 'gpt-4o-mini',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
        },
      })
      const client = new OpenAiClient('gpt-4o-mini', 'test-key')
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
        AiInvalidResponseError,
      )
    })
  })
})
