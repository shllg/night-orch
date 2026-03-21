import { describe, it, expect } from 'vitest'
import { parseCoderOutput } from '../../../src/workers/parsers/coder.js'

describe('parseCoderOutput', () => {
  it('parses valid coder JSON with all fields', () => {
    const raw = `\`\`\`json
{
  "summary": "Added timeout configuration and retry logic",
  "changedFiles": ["src/auth/login.ts", "src/config.ts"],
  "remainingUncertainty": "Edge case with concurrent sessions",
  "blockers": ["Need to verify session cleanup"]
}
\`\`\``
    const { result, error } = parseCoderOutput(raw)

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(result!.summary).toBe('Added timeout configuration and retry logic')
    expect(result!.changedFiles).toEqual(['src/auth/login.ts', 'src/config.ts'])
    expect(result!.remainingUncertainty).toBe('Edge case with concurrent sessions')
    expect(result!.blockers).toEqual(['Need to verify session cleanup'])
  })

  it('parses minimal valid coder output', () => {
    const raw = '```json\n{}\n```'
    const { result, error } = parseCoderOutput(raw)

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(result!.summary).toBe('No summary provided')
    expect(result!.changedFiles).toEqual([])
    expect(result!.remainingUncertainty).toBeNull()
    expect(result!.blockers).toBeNull()
  })

  it('returns error for non-JSON output', () => {
    const { result, error } = parseCoderOutput('Just some text about code changes')

    expect(result).toBeNull()
    expect(error).toContain('No JSON block found')
  })

  it('returns error for empty input', () => {
    const { result, error } = parseCoderOutput('')

    expect(result).toBeNull()
    expect(error).toContain('No JSON block found')
  })

  it('handles null blockers', () => {
    const raw = '```json\n{"summary": "Done", "blockers": null}\n```'
    const { result } = parseCoderOutput(raw)

    expect(result!.blockers).toBeNull()
  })

  it('handles missing optional fields', () => {
    const raw = '```json\n{"summary": "Fixed the bug"}\n```'
    const { result } = parseCoderOutput(raw)

    expect(result!.summary).toBe('Fixed the bug')
    expect(result!.changedFiles).toEqual([])
    expect(result!.remainingUncertainty).toBeNull()
    expect(result!.blockers).toBeNull()
  })

  it('filters non-string values from changedFiles', () => {
    const raw = '```json\n{"changedFiles": ["src/a.ts", 42, null, "src/b.ts"]}\n```'
    const { result } = parseCoderOutput(raw)

    expect(result!.changedFiles).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('handles non-array changedFiles gracefully', () => {
    const raw = '```json\n{"changedFiles": "src/a.ts"}\n```'
    const { result } = parseCoderOutput(raw)

    expect(result!.changedFiles).toEqual([])
  })

  it('parses direct JSON (no fence)', () => {
    const raw = '{"summary": "Direct JSON", "changedFiles": ["file.ts"]}'
    const { result, error } = parseCoderOutput(raw)

    expect(error).toBeNull()
    expect(result!.summary).toBe('Direct JSON')
    expect(result!.changedFiles).toEqual(['file.ts'])
  })
})
