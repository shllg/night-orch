import { describe, it, expect } from 'vitest'
import { extractCodexOutput } from '../../src/workers/parsers/dispatch.js'

describe('extractCodexOutput', () => {
  it('extracts agent_message text from JSON array format', () => {
    const raw = JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 'abc' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Hello from the plan' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'More plan details' } },
      { type: 'item.completed', item: { type: 'tool_call', name: 'read' } },
    ])

    const result = extractCodexOutput(raw)
    expect(result).toBe('Hello from the plan\nMore plan details')
  })

  it('extracts agent_message text from NDJSON format', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Plan step 1' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Plan step 2' } }),
    ]
    const raw = lines.join('\n')

    const result = extractCodexOutput(raw)
    expect(result).toBe('Plan step 1\nPlan step 2')
  })

  it('extracts text from message format with content array', () => {
    const raw = JSON.stringify([
      { type: 'message', content: [{ type: 'text', text: 'The plan is...' }] },
    ])

    const result = extractCodexOutput(raw)
    expect(result).toBe('The plan is...')
  })

  it('returns raw output when no structured events found', () => {
    const raw = 'Just plain text output from the worker'
    const result = extractCodexOutput(raw)
    expect(result).toBe(raw)
  })

  it('returns raw output when JSON has no agent_message events', () => {
    const raw = JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'item.completed', item: { type: 'tool_call', name: 'bash' } },
    ])

    const result = extractCodexOutput(raw)
    expect(result).toBe(raw)
  })

  it('handles mixed content: agent_message + message events', () => {
    const raw = JSON.stringify([
      { type: 'item.completed', item: { type: 'agent_message', text: 'First part' } },
      { type: 'message', content: [{ type: 'text', text: 'Second part' }] },
    ])

    const result = extractCodexOutput(raw)
    expect(result).toBe('First part\nSecond part')
  })

  it('handles empty input', () => {
    expect(extractCodexOutput('')).toBe('')
    expect(extractCodexOutput('  ')).toBe('  ')
  })

  it('handles truncated JSON array gracefully', () => {
    // Simulates output cut off mid-stream
    const raw = '[{"type":"system"},{"type":"item.completed","item":{"type":"agent_message","text":"partial"}},{"type":'
    const result = extractCodexOutput(raw)
    // Falls through to NDJSON parsing, individual lines may or may not parse
    expect(typeof result).toBe('string')
  })
})
