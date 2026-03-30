import { describe, it, expect } from 'vitest'
import { extractJsonBlock, parseJsonFromOutput, extractMarkedSection, repairAndParse } from '../../../src/workers/parsers/extract.js'

describe('extractJsonBlock', () => {
  it('extracts JSON from markdown fence', () => {
    const raw = `Here's the plan:\n\`\`\`json\n{"objective": "fix login"}\n\`\`\``
    const result = extractJsonBlock(raw)
    expect(result).toEqual({ objective: 'fix login' })
  })

  it('returns null for no JSON fence', () => {
    expect(extractJsonBlock('no json here')).toBeNull()
  })

  it('repairs truncated JSON in fenced block', () => {
    const raw = '```json\n{"objective": "Fix it", "steps": [\n```'
    const result = extractJsonBlock(raw)
    expect(result).toEqual({ objective: 'Fix it', steps: [] })
  })

  it('returns null for completely invalid content', () => {
    const raw = '```json\nnot json at all\n```'
    expect(extractJsonBlock(raw)).toBeNull()
  })

  it('extracts last JSON block when multiple exist', () => {
    const raw = '```json\n{"first": true}\n```\nmore text\n```json\n{"second": true}\n```'
    const result = extractJsonBlock(raw)
    expect(result).toEqual({ second: true })
  })

  it('extracts final JSON block from multi-turn output', () => {
    const raw = [
      'I found the following structure:',
      '```json\n{"type": "example", "note": "this is from a file I read"}\n```',
      'Based on my analysis of the codebase, here is my plan:',
      '```json\n{"objective": "Implement the feature"}\n```',
    ].join('\n\n')
    const result = extractJsonBlock(raw)
    expect(result).toEqual({ objective: 'Implement the feature' })
  })
})

describe('parseJsonFromOutput', () => {
  it('parses direct JSON string', () => {
    const result = parseJsonFromOutput('{"key": "value"}')
    expect(result).toEqual({ key: 'value' })
  })

  it('falls back to fenced block', () => {
    const raw = 'Some text\n```json\n{"key": "value"}\n```'
    const result = parseJsonFromOutput(raw)
    expect(result).toEqual({ key: 'value' })
  })
})

describe('repairAndParse', () => {
  it('closes unclosed braces', () => {
    const result = repairAndParse('{"key": "value"')
    expect(result).toEqual({ key: 'value' })
  })

  it('closes unclosed brackets', () => {
    const result = repairAndParse('{"items": [1, 2, 3')
    expect(result).toEqual({ items: [1, 2, 3] })
  })

  it('strips trailing commas', () => {
    const result = repairAndParse('{"a": 1, "b": 2,')
    expect(result).toEqual({ a: 1, b: 2 })
  })

  it('handles unterminated strings', () => {
    const result = repairAndParse('{"key": "unterminated')
    expect(result).toEqual({ key: 'unterminated' })
  })

  it('returns null for non-JSON input', () => {
    expect(repairAndParse('not json')).toBeNull()
    expect(repairAndParse('')).toBeNull()
  })

  it('handles deeply nested truncated objects', () => {
    const result = repairAndParse('{"a": {"b": {"c": 1')
    expect(result).toEqual({ a: { b: { c: 1 } } })
  })
})

describe('parseJsonFromOutput — progressive strategies', () => {
  it('extracts from unfenced ``` block containing JSON', () => {
    const raw = 'Here is the result:\n```\n{"verdict": "APPROVED"}\n```'
    const result = parseJsonFromOutput(raw)
    expect(result).toEqual({ verdict: 'APPROVED' })
  })

  it('extracts bare JSON object from text', () => {
    const raw = 'I analyzed the code and here is my verdict: {"verdict": "APPROVED", "summary": "Looks good"} That concludes my review.'
    const result = parseJsonFromOutput(raw)
    expect(result).toEqual({ verdict: 'APPROVED', summary: 'Looks good' })
  })

  it('repairs truncated JSON at end of output', () => {
    const raw = '{"objective": "Fix the bug", "steps": ["step1", "step2"'
    const result = parseJsonFromOutput(raw)
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>)['objective']).toBe('Fix the bug')
  })

  it('prefers ```json block over bare JSON', () => {
    const raw = '{"first": true}\nSome text\n```json\n{"second": true}\n```'
    // Full string parse would get {"first": true} but the raw doesn't start with {
    // Actually it does — so full string parse wins. Test a case where full fails.
    const raw2 = 'preamble {"bare": true}\n```json\n{"fenced": true}\n```'
    const result = parseJsonFromOutput(raw2)
    expect(result).toEqual({ fenced: true })
  })
})

describe('extractMarkedSection', () => {
  it('extracts content between markers', () => {
    const raw = 'before\n<!-- START -->\nContent here\n<!-- END -->\nafter'
    const result = extractMarkedSection(raw, '<!-- START -->', '<!-- END -->')
    expect(result).toBe('Content here')
  })

  it('returns null when start marker missing', () => {
    expect(extractMarkedSection('no markers', '<!-- START -->', '<!-- END -->')).toBeNull()
  })
})
