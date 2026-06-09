import { describe, it, expect } from 'vitest'
import { extractCodexTokenUsage } from '../../src/workers/parsers/dispatch.js'

/**
 * R4c: fixture-based token extraction tests for the Codex CLI adapter.
 *
 * Codex emits events in two shapes that the extractor tolerates:
 *  - NDJSON (one JSON object per line) — the default streaming format
 *  - JSON array — the output of `codex exec --output-last-message`
 *
 * The extractor prefers `response.completed` events (new Codex
 * format) and falls back to `turn.completed` (legacy) when no
 * `response.completed` events carry usage. Usage may live directly
 * on the event or nested under `response.usage`.
 *
 * These fixtures pin each shape so an upstream Codex format change
 * fails loudly at the extraction layer instead of silently
 * undercounting at the cost layer.
 */
describe('extractCodexTokenUsage (R4c fixtures)', () => {
  it('parses NDJSON with a single response.completed event', () => {
    const raw = [
      JSON.stringify({ type: 'session.started', thread_id: 't1' }),
      JSON.stringify({
        type: 'response.completed',
        usage: { input_tokens: 800, output_tokens: 250 },
      }),
    ].join('\n')
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 800,
      completionTokens: 250,
    })
  })

  it('parses NDJSON with nested response.usage on response.completed', () => {
    const raw = JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 1500, output_tokens: 400 } },
    })
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 1500,
      completionTokens: 400,
    })
  })

  it('includes cache_read_input_tokens as cacheReadTokens', () => {
    const raw = JSON.stringify({
      type: 'response.completed',
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_read_input_tokens: 900,
      },
    })
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 200,
      completionTokens: 50,
      cacheReadTokens: 900,
    })
  })

  it('omits cacheReadTokens when zero', () => {
    const raw = JSON.stringify({
      type: 'response.completed',
      usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0 },
    })
    const usage = extractCodexTokenUsage(raw)
    expect(usage).toEqual({ promptTokens: 50, completionTokens: 10 })
    expect(usage && 'cacheReadTokens' in usage).toBe(false)
  })

  it('sums usage across multiple response.completed events', () => {
    const raw = [
      JSON.stringify({ type: 'response.completed', usage: { input_tokens: 300, output_tokens: 80 } }),
      JSON.stringify({ type: 'response.completed', usage: { input_tokens: 150, output_tokens: 40 } }),
    ].join('\n')
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 450,
      completionTokens: 120,
    })
  })

  it('falls back to turn.completed events when no response.completed is present', () => {
    const raw = [
      JSON.stringify({ type: 'session.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 600, output_tokens: 200 } }),
    ].join('\n')
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 600,
      completionTokens: 200,
    })
  })

  it('prefers response.completed totals over turn.completed when both are present', () => {
    const raw = [
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9999, output_tokens: 9999 } }),
      JSON.stringify({ type: 'response.completed', usage: { input_tokens: 100, output_tokens: 50 } }),
    ].join('\n')
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 100,
      completionTokens: 50,
    })
  })

  it('parses the JSON array shape', () => {
    const raw = JSON.stringify([
      { type: 'session.started' },
      { type: 'response.completed', usage: { input_tokens: 77, output_tokens: 11 } },
    ])
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 77,
      completionTokens: 11,
    })
  })

  it('returns undefined when no events carry usage', () => {
    const raw = [
      JSON.stringify({ type: 'session.started' }),
      JSON.stringify({ type: 'response.completed' }),
    ].join('\n')
    expect(extractCodexTokenUsage(raw)).toBeUndefined()
  })

  it('returns undefined for empty output', () => {
    expect(extractCodexTokenUsage('')).toBeUndefined()
    expect(extractCodexTokenUsage('\n\n')).toBeUndefined()
  })

  it('returns undefined when all counters are zero', () => {
    const raw = JSON.stringify({
      type: 'response.completed',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    })
    expect(extractCodexTokenUsage(raw)).toBeUndefined()
  })

  it('parses the real codex exec --json turn.completed shape (cached_input_tokens + reasoning_output_tokens)', () => {
    // Ground-truth event captured from `codex exec --json` (CLI v0.136):
    // codex reports the cached portion under `cached_input_tokens`
    // (a subset of `input_tokens`) and reasoning tokens under
    // `reasoning_output_tokens` (billed as output). The extractor must
    // split the cached portion out of the prompt count and fold
    // reasoning tokens into completion so cost accounting matches the bill.
    const raw = JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 14766,
        cached_input_tokens: 3456,
        output_tokens: 22,
        reasoning_output_tokens: 15,
      },
    })
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 14766 - 3456,
      completionTokens: 22 + 15,
      cacheReadTokens: 3456,
    })
  })

  it('folds reasoning_output_tokens into completion when no cache is reported', () => {
    const raw = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 40 },
    })
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 800,
      completionTokens: 140,
    })
  })

  it('skips malformed NDJSON lines and parses the rest', () => {
    const raw = [
      '{garbage broken line',
      JSON.stringify({ type: 'response.completed', usage: { input_tokens: 42, output_tokens: 7 } }),
      'another broken line',
    ].join('\n')
    expect(extractCodexTokenUsage(raw)).toEqual({
      promptTokens: 42,
      completionTokens: 7,
    })
  })
})
