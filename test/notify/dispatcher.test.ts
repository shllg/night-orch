import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotificationDispatcher } from '../../src/notify/dispatcher.js'
import type { NotificationChannel, NotificationPayload } from '../../src/notify/types.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    event: 'pr_ready',
    repo: 'org/repo',
    issueNumber: 1,
    issueTitle: 'Fix bug',
    state: 'review_ready',
    prUrl: null,
    prNumber: null,
    summary: 'Done',
    blockingReason: null,
    reviewSummary: null,
    iterationCount: 1,
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makeChannel(type: string, success = true): NotificationChannel {
  return {
    type,
    send: vi.fn().mockResolvedValue(success),
    validate: vi.fn().mockResolvedValue({ valid: true, error: null }),
  }
}

const allEnabled = {
  onRunStarted: true,
  onBlocked: true,
  onPrReady: true,
  onPrUpdated: true,
  onError: true,
  onRetryExhausted: true,
}

describe('NotificationDispatcher', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('dispatches to all channels', async () => {
    const ch1 = makeChannel('console')
    const ch2 = makeChannel('webhook')
    const dispatcher = new NotificationDispatcher([ch1, ch2], allEnabled)

    const report = await dispatcher.dispatch(makePayload())

    expect(ch1.send).toHaveBeenCalledTimes(1)
    expect(ch2.send).toHaveBeenCalledTimes(1)
    expect(report.totalSent).toBe(2)
    expect(report.totalFailed).toBe(0)
  })

  it('skips disabled event', async () => {
    const ch = makeChannel('console')
    const dispatcher = new NotificationDispatcher([ch], {
      ...allEnabled,
      onRunStarted: false,
    })

    const report = await dispatcher.dispatch(makePayload({ event: 'run_started' }))

    expect(ch.send).not.toHaveBeenCalled()
    expect(report.sent).toHaveLength(0)
  })

  it('uses onPrUpdated toggle for pr_updated events', async () => {
    const ch = makeChannel('console')
    const dispatcher = new NotificationDispatcher([ch], {
      ...allEnabled,
      onPrUpdated: false,
    })

    const report = await dispatcher.dispatch(makePayload({ event: 'pr_updated' }))

    expect(ch.send).not.toHaveBeenCalled()
    expect(report.sent).toHaveLength(0)
  })

  it('one channel fails → others still called', async () => {
    const good = makeChannel('console', true)
    const bad = makeChannel('webhook', false)
    const dispatcher = new NotificationDispatcher([bad, good], allEnabled)

    const report = await dispatcher.dispatch(makePayload())

    expect(good.send).toHaveBeenCalledTimes(1)
    expect(bad.send).toHaveBeenCalledTimes(1)
    expect(report.totalSent).toBe(1)
    expect(report.totalFailed).toBe(1)
  })

  it('all channels fail → report shows all failures, no throw', async () => {
    const bad1 = makeChannel('console', false)
    const bad2 = makeChannel('webhook', false)
    const dispatcher = new NotificationDispatcher([bad1, bad2], allEnabled)

    const report = await dispatcher.dispatch(makePayload())

    expect(report.totalSent).toBe(0)
    expect(report.totalFailed).toBe(2)
  })

  it('channel throwing → caught, reported as failure', async () => {
    const throwing: NotificationChannel = {
      type: 'broken',
      send: vi.fn().mockRejectedValue(new Error('kaboom')),
      validate: vi.fn(),
    }
    const dispatcher = new NotificationDispatcher([throwing], allEnabled)

    const report = await dispatcher.dispatch(makePayload())

    expect(report.totalFailed).toBe(1)
    expect(report.sent[0]!.error).toContain('kaboom')
  })

  it('sendTest dispatches test payload to all channels', async () => {
    const ch = makeChannel('console')
    const dispatcher = new NotificationDispatcher([ch], allEnabled)

    const report = await dispatcher.sendTest()

    expect(ch.send).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(ch.send).mock.calls[0]![0]
    expect(payload.event).toBe('pr_ready')
    expect(payload.repo).toBe('test/test-repo')
    expect(report.totalSent).toBe(1)
  })

  it('report includes channel names', async () => {
    const ch = makeChannel('my-channel')
    const dispatcher = new NotificationDispatcher([ch], allEnabled)

    const report = await dispatcher.dispatch(makePayload())

    expect(report.sent[0]!.channel).toBe('my-channel')
  })
})
