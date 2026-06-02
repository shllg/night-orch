import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicClient } from '../../src/ai/anthropic.js'
import { OpenAiClient } from '../../src/ai/openai.js'
import { OpenRouterClient } from '../../src/ai/openrouter.js'

const REQUEST = {
  system: 'system',
  user: 'user',
  timeoutMs: 1_000,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AI provider error scrubbing', () => {
  it('scrubs Anthropic API keys from error messages', async () => {
    const leaked = 'sk-ant-api03-LEAKEDKEY1234567890'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`Authorization: ${leaked}`, { status: 401 })))

    const client = new AnthropicClient('claude-test', 'sk-ant-api03-CLIENTKEY')
    await expectRejectedMessageToExclude(client.complete(REQUEST), [leaked])
  })

  it('scrubs common provider tokens from OpenAI-compatible error messages', async () => {
    const github = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const aws = 'AKIA1234567890ABCDEF'
    const slack = 'xoxb-1234567890-abcdefghij0123456789'
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      new Response(`token=${github} aws ${aws} slack ${slack}`, { status: 401 }),
    )))

    const openai = new OpenAiClient('gpt-test', 'sk-test')
    await expectRejectedMessageToExclude(openai.complete(REQUEST), [github, aws, slack])

    const openrouter = new OpenRouterClient('openrouter-test', 'sk-or-test')
    await expectRejectedMessageToExclude(openrouter.complete(REQUEST), [github, aws, slack])
  })
})

async function expectRejectedMessageToExclude(promise: Promise<unknown>, forbidden: string[]): Promise<void> {
  try {
    await promise
    throw new Error('Expected promise to reject')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    for (const token of forbidden) {
      expect(message).not.toContain(token)
    }
    expect(message).toContain('[REDACTED]')
  }
}
