import { describe, it, expect, vi } from 'vitest'
import { ConsoleChannel } from '../../../src/notify/channels/console.js'
import type { NotificationPayload } from '../../../src/notify/types.js'

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { logger } from '../../../src/utils/logger.js'

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
    reviewSummary: 'APPROVED',
    iterationCount: 1,
    timestamp: new Date().toISOString(),
  }
}

describe('ConsoleChannel', () => {
  it('logs payload at info level', async () => {
    const channel = new ConsoleChannel()

    await channel.send(makePayload())

    expect(logger.info).toHaveBeenCalled()
    const msg = vi.mocked(logger.info).mock.calls[0]![1] as string
    expect(msg).toContain('pr_ready')
    expect(msg).toContain('Fix login')
  })

  it('always returns true', async () => {
    const channel = new ConsoleChannel()
    const result = await channel.send(makePayload())
    expect(result).toBe(true)
  })

  it('has type "console"', () => {
    const channel = new ConsoleChannel()
    expect(channel.type).toBe('console')
  })

  it('validate returns valid', async () => {
    const channel = new ConsoleChannel()
    const result = await channel.validate()
    expect(result.valid).toBe(true)
  })
})
