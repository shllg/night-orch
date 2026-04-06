import { describe, it, expect } from 'vitest'
import { sanitizeError, sanitizeErrorMessage } from '../../src/utils/sanitize-error.js'

describe('sanitizeErrorMessage', () => {
  it('returns benign messages unchanged', () => {
    expect(sanitizeErrorMessage('git push rejected: non-fast-forward')).toBe(
      'git push rejected: non-fast-forward',
    )
  })

  it('redacts GitHub PAT tokens', () => {
    const msg = 'fatal: token ghp_abcdefghijklmnopqrstuvwxyz1234567890 invalid'
    const out = sanitizeErrorMessage(msg)
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts github_pat_ fine-grained tokens', () => {
    const out = sanitizeErrorMessage(
      'permission denied: github_pat_11ABCDEFG0abcdefghij_abcdefghijklmnopqrstuvwxyzabcdefghij',
    )
    expect(out).not.toMatch(/github_pat_/)
  })

  it('redacts embedded credentials in git remote URLs', () => {
    const out = sanitizeErrorMessage(
      'fatal: unable to access https://x-access-token:ghp_abc1234567890123456789@github.com/org/repo.git: 403',
    )
    expect(out).not.toContain('ghp_abc1234567890123456789')
    expect(out).not.toContain('x-access-token')
    expect(out).toContain('github.com/org/repo.git')
  })

  it('redacts key=value style token echoes', () => {
    const out = sanitizeErrorMessage('spawn failed: GITHUB_TOKEN=ghp_abc1234567890 not set in env')
    expect(out).toContain('GITHUB_TOKEN=[REDACTED]')
    expect(out).not.toContain('ghp_abc1234567890')
  })

  it('redacts secret= and password= in error strings', () => {
    const out = sanitizeErrorMessage('auth failed with password=hunter2 and secret=xyz')
    expect(out).toContain('password=[REDACTED]')
    expect(out).toContain('secret=[REDACTED]')
    expect(out).not.toContain('hunter2')
  })

  it('redacts access_token query parameters', () => {
    const out = sanitizeErrorMessage('GET https://api.example.com/things?access_token=abc123xyz failed: 403')
    expect(out).not.toContain('abc123xyz')
    expect(out).toContain('access_token=[REDACTED]')
  })

  it('handles empty and unknown inputs safely', () => {
    expect(sanitizeErrorMessage('')).toBe('')
  })

  it('does not mangle long benign strings (UUIDs, hashes, command output)', () => {
    const sha = 'a'.repeat(64) // fake git SHA-ish
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const line = `built commit ${sha} uuid=${uuid}`
    const out = sanitizeErrorMessage(line)
    // SHA runs should not be redacted by a generic high-entropy catch
    expect(out).toContain(sha)
    expect(out).toContain(uuid)
  })

  it('redacts Slack and AWS vendor-prefixed tokens', () => {
    const slack = 'xoxb-1234567890-abcdefghij0123456789'
    const aws = 'AKIA1234567890ABCDEF'
    const out = sanitizeErrorMessage(`using ${slack} and ${aws}`)
    expect(out).not.toContain(slack)
    expect(out).not.toContain(aws)
  })
})

describe('sanitizeError', () => {
  it('scrubs Error instances', () => {
    const err = new Error('Authorization: token ghp_abcdefghijklmnopqrstuvwxyz1234 failed')
    const out = sanitizeError(err)
    expect(out.name).toBe('Error')
    expect(out.message).not.toContain('ghp_')
    expect(out.stack).toBeDefined()
  })

  it('scrubs plain-string errors', () => {
    const out = sanitizeError('ghp_abcdefghijklmnopqrstuvwxyz1234 is invalid')
    expect(out.message).not.toContain('ghp_')
  })

  it('handles non-Error objects', () => {
    const out = sanitizeError({ code: 'EAUTH', token: 'ghp_secret1234567890123456' })
    expect(out.message).not.toContain('ghp_secret1234567890123456')
  })

  it('returns unknown error sentinel for non-serializable inputs', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const out = sanitizeError(circular)
    expect(out.message).toBe('unknown error')
  })
})
