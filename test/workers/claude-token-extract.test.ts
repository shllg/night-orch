import { describe, it, expect } from 'vitest'
import { extractClaudeTokenUsage } from '../../src/workers/claude.js'

/**
 * R4c: fixture-based token extraction tests for the Claude Code CLI
 * adapter. These pin the exact parsing contract the adapter relies
 * on so a future output-format change in `claude` (or an accidental
 * regression of the extractor) fails loudly and at the right layer.
 *
 * Fixtures are synthetic but mirror the shapes observed in
 * production Claude Code stream-json output:
 *  - single `{type:'result', usage:{…}}` object
 *  - streaming JSON array of events ending in a result event
 *  - result event with cache_creation + cache_read counters
 *  - zero-usage result → undefined (triggers R4a block path)
 *  - unparseable output → undefined
 */
describe('extractClaudeTokenUsage (R4c fixtures)', () => {
  it('parses a single result object with plain usage', () => {
    const raw = JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 1234,
        output_tokens: 567,
      },
    })
    expect(extractClaudeTokenUsage(raw)).toEqual({
      promptTokens: 1234,
      completionTokens: 567,
    })
  })

  it('parses a streaming array with a single result event', () => {
    const raw = JSON.stringify([
      { type: 'system', session_id: 'abc' },
      { type: 'assistant', text: 'working' },
      { type: 'result', usage: { input_tokens: 900, output_tokens: 300 } },
    ])
    expect(extractClaudeTokenUsage(raw)).toEqual({
      promptTokens: 900,
      completionTokens: 300,
    })
  })

  it('adds cache_creation_input_tokens into promptTokens', () => {
    const raw = JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 500,
        cache_creation_input_tokens: 300,
        output_tokens: 100,
      },
    })
    expect(extractClaudeTokenUsage(raw)).toEqual({
      promptTokens: 800,
      completionTokens: 100,
    })
  })

  it('exposes cache_read_input_tokens as a separate cacheReadTokens field', () => {
    const raw = JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 200,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 1000,
        output_tokens: 75,
      },
    })
    expect(extractClaudeTokenUsage(raw)).toEqual({
      promptTokens: 250,
      completionTokens: 75,
      cacheReadTokens: 1000,
    })
  })

  it('omits cacheReadTokens when zero', () => {
    const raw = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    })
    const usage = extractClaudeTokenUsage(raw)
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5 })
    expect(usage && 'cacheReadTokens' in usage).toBe(false)
  })

  it('sums usage across multiple result events in a streaming array', () => {
    const raw = JSON.stringify([
      { type: 'result', usage: { input_tokens: 100, output_tokens: 50 } },
      { type: 'result', usage: { input_tokens: 200, output_tokens: 80 } },
    ])
    expect(extractClaudeTokenUsage(raw)).toEqual({
      promptTokens: 300,
      completionTokens: 130,
    })
  })

  it('ignores non-result events when scanning an array', () => {
    const raw = JSON.stringify([
      { type: 'system', session_id: 'abc' },
      { type: 'assistant', usage: { input_tokens: 99999, output_tokens: 99999 } },
      { type: 'result', usage: { input_tokens: 42, output_tokens: 7 } },
    ])
    expect(extractClaudeTokenUsage(raw)).toEqual({
      promptTokens: 42,
      completionTokens: 7,
    })
  })

  it('returns undefined when usage is missing on the result event', () => {
    const raw = JSON.stringify({ type: 'result' })
    expect(extractClaudeTokenUsage(raw)).toBeUndefined()
  })

  it('returns undefined when all counters are zero', () => {
    const raw = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    })
    expect(extractClaudeTokenUsage(raw)).toBeUndefined()
  })

  it('returns undefined for non-JSON output', () => {
    expect(extractClaudeTokenUsage('plain text banner')).toBeUndefined()
    expect(extractClaudeTokenUsage('')).toBeUndefined()
  })

  it('returns undefined for malformed JSON', () => {
    expect(extractClaudeTokenUsage('{"type": "result", "usage":')).toBeUndefined()
  })

  it('returns undefined for JSON without a result event', () => {
    const raw = JSON.stringify([
      { type: 'system', session_id: 'abc' },
      { type: 'assistant', text: 'working' },
    ])
    expect(extractClaudeTokenUsage(raw)).toBeUndefined()
  })

  it('treats negative or non-numeric counters as zero', () => {
    const raw = JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: -10,
        output_tokens: 'not-a-number',
        cache_read_input_tokens: null,
      },
    })
    expect(extractClaudeTokenUsage(raw)).toBeUndefined()
  })
})
