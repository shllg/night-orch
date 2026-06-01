import { describe, expect, it } from 'vitest'
import { sanitizeErrorForComment } from '../../src/runner/comment-formatting.js'

describe('sanitizeErrorForComment', () => {
  it.each([
    ['GitHub classic token', 'push failed: ghp_abcdefghijklmnopqrstuvwxyz123456'],
    ['GitHub fine-grained token', 'push failed: github_pat_abcdefghijklmnopqrstuvwxyz123456'],
    ['OpenAI token', 'request failed: sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['AWS access key', 'aws failed: AKIAABCDEFGHIJKLMNOP'],
    ['AWS session key', 'aws failed: ASIAABCDEFGHIJKLMNOP'],
    ['Google API key', 'google failed: AIzaabcdefghijklmnopqrstuvwxyz'],
    ['Slack token', 'slack failed: xoxb-abcdefghijklmnopqrstuvwx'],
  ])('redacts bare %s shapes', (_label, message) => {
    const sanitized = sanitizeErrorForComment(message)

    expect(sanitized).toContain('\\[REDACTED\\]')
    expect(sanitized).not.toContain(message.split(': ').at(-1))
  })

  it.each([
    ['token', 'token=ghp_abcdefghijklmnopqrstuvwxyz123456'],
    ['secret', 'secret:super-secret-value'],
    ['password', 'password = hunter2'],
    ['passwd', 'passwd: hunter2'],
    ['api_key', 'api_key=AIzaabcdefghijklmnopqrstuvwxyz'],
    ['api-key', 'api-key:AIzaabcdefghijklmnopqrstuvwxyz'],
  ])('redacts %s key-value echoes', (_label, message) => {
    const sanitized = sanitizeErrorForComment(`failed with ${message}`)

    expect(sanitized).toContain('\\[REDACTED\\]')
    expect(sanitized).not.toContain(message.split(/[:=]/).at(-1)?.trim())
  })

  it('collapses newlines, control characters, and repeated whitespace', () => {
    expect(sanitizeErrorForComment('first\n\nsecond\t\u0000third')).toBe('first second third')
  })

  it('escapes markdown, angle brackets, and mentions before public comments', () => {
    const sanitized = sanitizeErrorForComment('@maintainer `code` *boom* #1 [link] <tag>')

    expect(sanitized).toBe('@\u200Bmaintainer \\`code\\` \\*boom\\* \\#1 \\[link\\] &lt;tag&gt;')
  })

  it('falls back when the sanitized message is empty', () => {
    expect(sanitizeErrorForComment('\n\t\u0000')).toBe('unknown error')
  })

  it('clips long messages before escaping', () => {
    const sanitized = sanitizeErrorForComment('a'.repeat(500))

    expect(sanitized).toHaveLength(400)
    expect(sanitized.endsWith('…')).toBe(true)
  })
})
