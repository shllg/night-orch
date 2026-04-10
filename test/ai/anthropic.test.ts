import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { AnthropicClient } from '../../src/ai/anthropic.js'
import {
  AiAuthError,
  AiInvalidResponseError,
  AiRateLimitError,
  AiTransientError,
} from '../../src/ai/errors.js'

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

describe('AnthropicClient', () => {
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
          id: 'msg_123',
          model: 'claude-3-5-sonnet',
          content: [{ type: 'text', text: 'hello world' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 5 },
        },
      })

      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      const result = await client.complete({ system: 's', user: 'u' })

      expect(result.text).toBe('hello world')
      expect(result.resolvedModel).toBe('claude-3-5-sonnet')
      expect(result.finishReason).toBe('stop')
      expect(result.usage.promptTokens).toBe(12)
      expect(result.usage.completionTokens).toBe(5)
    })

    it('maps max_tokens stop reason to length', async () => {
      stubFetch({
        status: 200,
        body: {
          id: 'msg_123',
          model: 'claude-3-5-sonnet',
          content: [{ type: 'text', text: 'truncated' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 10, output_tokens: 1024 },
        },
      })
      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      const result = await client.complete({ system: 's', user: 'u' })
      expect(result.finishReason).toBe('length')
    })

    it('includes cache_creation_input_tokens in promptTokens', async () => {
      stubFetch({
        status: 200,
        body: {
          id: 'msg_123',
          model: 'claude-3-5-sonnet',
          content: [{ type: 'text', text: 'x' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 500,
            output_tokens: 50,
          },
        },
      })
      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      const result = await client.complete({ system: 's', user: 'u' })
      expect(result.usage.promptTokens).toBe(300)
      expect(result.usage.cacheReadTokens).toBe(500)
    })

    it('throws AiAuthError on 401', async () => {
      stubFetch({ status: 401, body: { error: { type: 'authentication_error', message: 'bad key' } } })
      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(AiAuthError)
    })

    it('throws AiRateLimitError on 429', async () => {
      stubFetch({ status: 429, body: { error: { type: 'rate_limit', retry_after: 5 } } })
      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      try {
        await client.complete({ system: 's', user: 'u' })
        expect.fail('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(AiRateLimitError)
        if (err instanceof AiRateLimitError) {
          expect(err.retryAfterMs).toBe(5000)
        }
      }
    })

    it('throws AiTransientError on 500', async () => {
      stubFetch({ status: 500, body: 'internal error' })
      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(AiTransientError)
    })

    it('throws AiInvalidResponseError when the response has no text blocks', async () => {
      stubFetch({
        status: 200,
        body: {
          id: 'msg_123',
          model: 'claude-3-5-sonnet',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      })
      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
        AiInvalidResponseError,
      )
    })

    it('throws AiTransientError on fetch network failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENETUNREACH')) as unknown as typeof fetch
      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(AiTransientError)
    })

    it('sends the expected headers and body shape', async () => {
      const mock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'msg',
            model: 'claude-3-5-sonnet',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
      )
      globalThis.fetch = mock as unknown as typeof fetch
      const client = new AnthropicClient('claude-3-5-sonnet', 'secret-key')
      await client.complete({ system: 'sys', user: 'usr', maxTokens: 42, temperature: 0.3 })
      expect(mock).toHaveBeenCalledTimes(1)
      const [url, init] = mock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(ANTHROPIC_MESSAGES_URL)
      const headers = init.headers as Record<string, string>
      expect(headers['x-api-key']).toBe('secret-key')
      expect(headers['anthropic-version']).toBe('2023-06-01')
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['model']).toBe('claude-3-5-sonnet')
      expect(body['max_tokens']).toBe(42)
      expect(body['temperature']).toBe(0.3)
      expect(body['system']).toBe('sys')
      expect(body['messages']).toEqual([{ role: 'user', content: 'usr' }])
    })
  })

  describe('completeStructured', () => {
    it('extracts validated JSON from the model response', async () => {
      stubFetch({
        status: 200,
        body: {
          id: 'msg_123',
          model: 'claude-3-5-sonnet',
          content: [
            {
              type: 'text',
              text: '{"level":"trivial","reason":"short"}',
            },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      })

      const schema = z.object({
        level: z.enum(['trivial', 'standard', 'architectural']),
        reason: z.string(),
      })
      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      const result = await client.completeStructured(
        { system: 's', user: 'u' },
        schema,
      )
      expect(result).toEqual({ level: 'trivial', reason: 'short' })
    })

    it('injects a "reply with JSON only" hint into the system prompt', async () => {
      const mock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'msg',
            model: 'claude-3-5-sonnet',
            content: [{ type: 'text', text: '{"a":1}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
      )
      globalThis.fetch = mock as unknown as typeof fetch
      const client = new AnthropicClient('claude-3-5-sonnet', 'test-key')
      await client.completeStructured(
        { system: 'original system', user: 'u' },
        z.object({ a: z.number() }),
      )
      const [, init] = mock.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body['system']).toContain('original system')
      expect(body['system']).toContain('JSON')
    })
  })
})
