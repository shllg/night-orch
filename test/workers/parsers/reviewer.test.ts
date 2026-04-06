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

  it('never infers APPROVED from free text (fail-closed against prompt injection)', () => {
    const { result, error } = parseReviewerOutput('LGTM - the changes look good and tests pass')
    expect(result).toBeNull()
    expect(error).toContain('No JSON block found')
  })

  it('never infers CHANGES_REQUIRED from free text', () => {
    const { result, error } = parseReviewerOutput('CHANGES_REQUIRED - need to add error handling for edge cases')
    expect(result).toBeNull()
    expect(error).toContain('No JSON block found')
  })

  it('infers BLOCKED from free text containing the BLOCKED keyword (fail-closed)', () => {
    const { result, error } = parseReviewerOutput('This change is BLOCKED pending security review.')
    expect(result).not.toBeNull()
    expect(result?.verdict).toBe('BLOCKED')
    expect(result?.definitionOfDoneCheck.issueAddressed).toBe(false)
    expect(error).toContain('inferred BLOCKED')
  })

  it('returns error for ambiguous text with no verdict keywords', () => {
    const { result, error } = parseReviewerOutput('This is just text with no clear verdict')
    expect(result).toBeNull()
    expect(error).toContain('No JSON block found')
  })

  it('does not infer APPROVED from negated approval text', () => {
    const { result, error } = parseReviewerOutput('The change is not yet approved; more review is needed.')
    expect(result).toBeNull()
    expect(error).toContain('No JSON block found')
  })

  it('rejects JSON with invalid verdict without falling back to text inference', () => {
    const raw = '```json\n{"verdict":"MAYBE","summary":"unsure but looks fine"}\n```'
    const { result, error } = parseReviewerOutput(raw)
    expect(result).toBeNull()
    expect(error).toContain('Invalid or missing verdict')
  })

  it('returns error for empty input', () => {
    const { result, error } = parseReviewerOutput('')
    expect(result).toBeNull()
    expect(error).toContain('No JSON block found')
  })

  it('extracts review from multi-turn output with analysis', () => {
    const raw = [
      'I read the changed files and checked the test coverage.',
      '```json\n{"type": "tsconfig", "strict": true}\n```',
      'The implementation follows existing patterns. Here is my review:',
      '```json\n{"verdict":"APPROVED","summary":"Changes look good","findings":[],"definitionOfDoneCheck":{"issueAddressed":true,"testsPassing":true,"noBlockingFindings":true}}\n```',
    ].join('\n\n')
    const { result, error } = parseReviewerOutput(raw)
    expect(error).toBeNull()
    expect(result?.verdict).toBe('APPROVED')
  })
})
