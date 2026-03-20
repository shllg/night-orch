import { describe, it, expect } from 'vitest'
import { slugify, branchName, generateRunId } from '../../src/utils/ids.js'

describe('slugify', () => {
  it('lowercases and strips special chars', () => {
    expect(slugify('Fix Login Timeout')).toBe('fix-login-timeout')
  })

  it('collapses multiple hyphens', () => {
    expect(slugify('foo---bar')).toBe('foo-bar')
  })

  it('strips leading/trailing hyphens', () => {
    expect(slugify('--foo-bar--')).toBe('foo-bar')
  })

  it('truncates to max length', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long, 40).length).toBeLessThanOrEqual(40)
  })

  it('does not end with a hyphen after truncation', () => {
    const result = slugify('this-is-a-really-long-issue-title-that-should-be-truncated', 20)
    expect(result).not.toMatch(/-$/)
  })

  it('handles empty input', () => {
    expect(slugify('')).toBe('')
  })

  it('handles unicode', () => {
    expect(slugify('Fix für Ärger')).toBe('fix-f-r-rger')
  })
})

describe('branchName', () => {
  it('produces deterministic branch names', () => {
    expect(branchName('orch', 123, 'fix-login-timeout')).toBe('orch/123-fix-login-timeout')
  })
})

describe('generateRunId', () => {
  it('produces unique IDs', () => {
    const a = generateRunId()
    const b = generateRunId()
    expect(a).not.toBe(b)
  })

  it('starts with run-', () => {
    expect(generateRunId()).toMatch(/^run-/)
  })
})
