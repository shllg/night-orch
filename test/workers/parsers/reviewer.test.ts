import { describe, it, expect } from 'vitest'
import { parseReviewerOutput } from '../../../src/workers/parsers/reviewer.js'

describe('parseReviewerOutput', () => {
  it('parses APPROVED verdict', () => {
    const raw = '```json\n{"verdict":"APPROVED","summary":"Looks good","findings":[],"definitionOfDoneCheck":{"issueAddressed":true,"testsPassing":true,"noBlockingFindings":true}}\n```'
    const { result, error } = parseReviewerOutput(raw)
    expect(error).toBeNull()
    expect(result?.verdict).toBe('APPROVED')
  })

  it('parses CHANGES_REQUIRED with findings', () => {
    const raw = `\`\`\`json
{
  "verdict": "CHANGES_REQUIRED",
  "summary": "Needs work",
  "findings": [
    {"severity": "major", "message": "Missing error handling", "suggestedFix": "Add try/catch"}
  ],
  "definitionOfDoneCheck": {"issueAddressed": false, "testsPassing": true, "noBlockingFindings": false}
}
\`\`\``
    const { result, error } = parseReviewerOutput(raw)
    expect(error).toBeNull()
    expect(result?.verdict).toBe('CHANGES_REQUIRED')
    expect(result?.findings).toHaveLength(1)
    expect(result?.findings[0]?.severity).toBe('major')
  })

  it('rejects invalid verdict', () => {
    const raw = '```json\n{"verdict":"MAYBE","summary":"unsure"}\n```'
    const { result, error } = parseReviewerOutput(raw)
    expect(result).toBeNull()
    expect(error).toContain('Invalid or missing verdict')
  })

  it('returns error for non-JSON output', () => {
    const { result, error } = parseReviewerOutput('This is just text')
    expect(result).toBeNull()
    expect(error).toContain('No JSON block found')
  })
})
