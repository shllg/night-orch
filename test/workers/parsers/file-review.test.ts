import { describe, expect, it } from 'vitest'
import { parseFileReviewOutput } from '../../../src/workers/parsers/file-review.js'

describe('parseFileReviewOutput', () => {
  it('parses well-formed output', () => {
    const parsed = parseFileReviewOutput(JSON.stringify({
      summary: 'Tightened wording',
      difficulty: 'trivial',
      refactorNotes: null,
      trivialFixes: [{ filePath: 'src/app.ts', search: 'foo', replace: 'bar' }],
    }), 'src/app.ts')

    expect(parsed.error).toBeNull()
    expect(parsed.result?.difficulty).toBe('trivial')
  })

  it('rejects malformed output', () => {
    const parsed = parseFileReviewOutput('not json', 'src/app.ts')
    expect(parsed.result).toBeNull()
    expect(parsed.error).toContain('No JSON block')
  })

  it('rejects edits targeting another file', () => {
    const parsed = parseFileReviewOutput(JSON.stringify({
      summary: 'Bad edit',
      difficulty: 'trivial',
      refactorNotes: null,
      trivialFixes: [{ filePath: 'src/other.ts', search: 'foo', replace: 'bar' }],
    }), 'src/app.ts')

    expect(parsed.result).toBeNull()
    expect(parsed.error).toContain('expected only src/app.ts')
  })
})
