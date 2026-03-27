import { describe, it, expect } from 'vitest'
import { extractJsonBlock, parseJsonFromOutput, extractMarkedSection } from '../../../src/workers/parsers/extract.js'

describe('extractJsonBlock', () => {
  it('extracts JSON from markdown fence', () => {
    const raw = `Here's the plan:\n\`\`\`json\n{"objective": "fix login"}\n\`\`\``
    const result = extractJsonBlock(raw)
    expect(result).toEqual({ objective: 'fix login' })
  })

  it('returns null for no JSON fence', () => {
    expect(extractJsonBlock('no json here')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const raw = '```json\n{invalid json}\n```'
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
