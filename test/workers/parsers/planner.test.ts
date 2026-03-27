import { describe, it, expect } from 'vitest'
import { parsePlannerOutput } from '../../../src/workers/parsers/planner.js'

describe('parsePlannerOutput', () => {
  it('parses valid planner JSON with all fields', () => {
    const raw = `\`\`\`json
{
  "objective": "Fix the login timeout",
  "assumptions": ["Auth service is healthy", "DB is accessible"],
  "filesToChange": ["src/auth/login.ts", "src/auth/session.ts"],
  "steps": [
    {"order": 1, "description": "Add timeout config", "files": ["src/config.ts"]},
    {"order": 2, "description": "Implement retry logic", "files": ["src/auth/login.ts"]}
  ],
  "risks": ["May affect existing sessions"],
  "testStrategy": "Unit tests for timeout logic"
}
\`\`\``
    const { result, error } = parsePlannerOutput(raw)

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(result!.objective).toBe('Fix the login timeout')
    expect(result!.assumptions).toEqual(['Auth service is healthy', 'DB is accessible'])
    expect(result!.filesToChange).toEqual(['src/auth/login.ts', 'src/auth/session.ts'])
    expect(result!.steps).toHaveLength(2)
    expect(result!.steps[0]!.order).toBe(1)
    expect(result!.steps[0]!.description).toBe('Add timeout config')
    expect(result!.steps[0]!.files).toEqual(['src/config.ts'])
    expect(result!.risks).toEqual(['May affect existing sessions'])
    expect(result!.testStrategy).toBe('Unit tests for timeout logic')
  })

  it('parses minimal valid planner output (only objective)', () => {
    const raw = '```json\n{"objective": "Fix the bug"}\n```'
    const { result, error } = parsePlannerOutput(raw)

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(result!.objective).toBe('Fix the bug')
    expect(result!.assumptions).toEqual([])
    expect(result!.filesToChange).toEqual([])
    expect(result!.steps).toEqual([])
    expect(result!.risks).toEqual([])
    expect(result!.testStrategy).toBe('')
  })

  it('returns error when objective is missing', () => {
    const raw = '```json\n{"assumptions": ["test"]}\n```'
    const { result, error } = parsePlannerOutput(raw)

    expect(result).toBeNull()
    expect(error).toContain('missing "objective"')
  })

  it('falls back to text when no JSON block found', () => {
    const { result, error } = parsePlannerOutput('This is just plain text')

    expect(result).not.toBeNull()
    expect(result!.objective).toBe('This is just plain text')
    expect(result!.steps).toEqual([])
    expect(error).toContain('fallback')
  })

  it('returns error for empty input', () => {
    const { result, error } = parsePlannerOutput('')

    expect(result).toBeNull()
    expect(error).toContain('No JSON block found')
  })

  it('handles steps without order field (uses index)', () => {
    const raw = '```json\n{"objective": "Fix", "steps": [{"description": "Do thing", "files": ["a.ts"]}]}\n```'
    const { result } = parsePlannerOutput(raw)

    expect(result!.steps[0]!.order).toBe(1) // defaults to index + 1
  })

  it('filters non-string values from string arrays', () => {
    const raw = '```json\n{"objective": "Fix", "assumptions": ["valid", 123, null, "also valid"]}\n```'
    const { result } = parsePlannerOutput(raw)

    expect(result!.assumptions).toEqual(['valid', 'also valid'])
  })

  it('handles non-array assumptions gracefully', () => {
    const raw = '```json\n{"objective": "Fix", "assumptions": "not an array"}\n```'
    const { result } = parsePlannerOutput(raw)

    expect(result!.assumptions).toEqual([])
  })

  it('parses direct JSON (no fence)', () => {
    const raw = '{"objective": "Direct JSON"}'
    const { result, error } = parsePlannerOutput(raw)

    expect(error).toBeNull()
    expect(result!.objective).toBe('Direct JSON')
  })

  it('extracts plan from multi-turn output with analysis', () => {
    const raw = [
      'I explored the codebase and found the following structure:',
      '```json\n{"type": "package.json", "name": "my-app"}\n```',
      'The config uses a standard pattern. Based on my analysis:',
      '```json\n{"objective": "Add user auth", "steps": [{"order": 1, "description": "Create auth module", "files": ["src/auth.ts"]}]}\n```',
    ].join('\n\n')
    const { result, error } = parsePlannerOutput(raw)

    expect(error).toBeNull()
    expect(result!.objective).toBe('Add user auth')
    expect(result!.steps).toHaveLength(1)
  })
})
