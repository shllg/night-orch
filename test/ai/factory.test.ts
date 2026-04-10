import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createAiClient } from '../../src/ai/factory.js'
import { AnthropicClient } from '../../src/ai/anthropic.js'
import { OpenRouterClient } from '../../src/ai/openrouter.js'
import type { Config } from '../../src/config/schema.js'

function makeConfig(overrides: Partial<Config['ai']['internal']> = {}): Config {
  return {
    ai: {
      internal: {
        provider: null,
        model: null,
        apiKeyEnv: null,
        timeoutMs: 30_000,
        maxTokens: 1024,
        enable: {
          triage: false,
          reviewerParseFallback: false,
          prBody: false,
        },
        ...overrides,
      },
    },
  } as unknown as Config
}

describe('createAiClient', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    originalEnv['TEST_ANTHROPIC_KEY'] = process.env['TEST_ANTHROPIC_KEY']
    originalEnv['TEST_OR_KEY'] = process.env['TEST_OR_KEY']
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('returns null when no provider is configured', () => {
    expect(createAiClient(makeConfig())).toBeNull()
  })

  it('returns null when provider is set but model is missing', () => {
    expect(
      createAiClient(
        makeConfig({ provider: 'anthropic', model: null, apiKeyEnv: 'TEST_ANTHROPIC_KEY' }),
      ),
    ).toBeNull()
  })

  it('returns null when apiKeyEnv points at an unset env var', () => {
    delete process.env['TEST_ANTHROPIC_KEY']
    const client = createAiClient(
      makeConfig({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'TEST_ANTHROPIC_KEY',
      }),
    )
    expect(client).toBeNull()
  })

  it('builds an AnthropicClient when configured for anthropic', () => {
    process.env['TEST_ANTHROPIC_KEY'] = 'secret'
    const client = createAiClient(
      makeConfig({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'TEST_ANTHROPIC_KEY',
      }),
    )
    expect(client).toBeInstanceOf(AnthropicClient)
    expect(client?.provider).toBe('anthropic')
    expect(client?.model).toBe('claude-3-5-sonnet')
  })

  it('builds an OpenRouterClient when configured for openrouter', () => {
    process.env['TEST_OR_KEY'] = 'sk-or-test'
    const client = createAiClient(
      makeConfig({
        provider: 'openrouter',
        model: 'anthropic/claude-3-5-sonnet',
        apiKeyEnv: 'TEST_OR_KEY',
      }),
    )
    expect(client).toBeInstanceOf(OpenRouterClient)
    expect(client?.provider).toBe('openrouter')
    expect(client?.model).toBe('anthropic/claude-3-5-sonnet')
  })
})
