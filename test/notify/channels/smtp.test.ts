import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SmtpChannel } from '../../../src/notify/channels/smtp.js'
import type { NotificationPayload } from '../../../src/notify/types.js'

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makePayload(): NotificationPayload {
  return {
    event: 'pr_ready',
    repo: 'org/repo',
    issueNumber: 42,
    issueTitle: 'Fix login',
    state: 'review_ready',
    prUrl: 'https://github.com/org/repo/pull/10',
    prNumber: 10,
    summary: 'Fixed the login timeout',
    blockingReason: null,
    reviewSummary: null,
    iterationCount: 1,
    timestamp: new Date().toISOString(),
  }
}

describe('SmtpChannel', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns false when credentials not set', async () => {
    delete process.env['SMTP_USER']
    delete process.env['SMTP_PASS']

    const channel = new SmtpChannel('smtp.example.com', 587, 'from@test.com', 'to@test.com', 'SMTP_USER', 'SMTP_PASS')
    const result = await channel.send(makePayload())

    expect(result).toBe(false)
  })

  it('validate returns invalid when env vars missing', async () => {
    delete process.env['SMTP_USER']
    delete process.env['SMTP_PASS']

    const channel = new SmtpChannel('smtp.example.com', 587, 'from@test.com', 'to@test.com', 'SMTP_USER', 'SMTP_PASS')
    const result = await channel.validate()

    expect(result.valid).toBe(false)
    expect(result.error).toContain('SMTP_USER')
  })

  it('validate returns valid when env vars set', async () => {
    process.env['SMTP_USER'] = 'user@test.com'
    process.env['SMTP_PASS'] = 'secret'

    const channel = new SmtpChannel('smtp.example.com', 587, 'from@test.com', 'to@test.com', 'SMTP_USER', 'SMTP_PASS')
    const result = await channel.validate()

    expect(result.valid).toBe(true)
  })

  it('has type "smtp"', () => {
    const channel = new SmtpChannel('smtp.example.com', 587, 'from@test.com', 'to@test.com', 'SMTP_USER', 'SMTP_PASS')
    expect(channel.type).toBe('smtp')
  })

  it('returns false when nodemailer not available', async () => {
    process.env['SMTP_USER'] = 'user@test.com'
    process.env['SMTP_PASS'] = 'secret'

    const channel = new SmtpChannel('smtp.example.com', 587, 'from@test.com', 'to@test.com', 'SMTP_USER', 'SMTP_PASS')
    // nodemailer is not installed, so the dynamic import will fail
    const result = await channel.send(makePayload())

    expect(result).toBe(false)
  })
})
