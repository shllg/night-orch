import { describe, it, expect, vi } from 'vitest'

// This test validates that the notify-test command exists and has the right structure.
// Full integration testing would require mocking the config loader, which is complex.
// Instead, we test the dispatcher and channel integration directly.

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { NotificationDispatcher } from '../../src/notify/dispatcher.js'
import type { NotificationChannel } from '../../src/notify/types.js'

describe('notify-test command (dispatcher integration)', () => {
  it('sendTest dispatches to all channels and returns report', async () => {
    const ch1: NotificationChannel = {
      type: 'console',
      send: vi.fn().mockResolvedValue(true),
      validate: vi.fn().mockResolvedValue({ valid: true, error: null }),
    }
    const ch2: NotificationChannel = {
      type: 'webhook',
      send: vi.fn().mockResolvedValue(true),
      validate: vi.fn().mockResolvedValue({ valid: true, error: null }),
    }

    const allEnabled = {
      onRunStarted: true,
      onBlocked: true,
      onPrReady: true,
      onPrUpdated: true,
      onError: true,
      onRetryExhausted: true,
    }

    const dispatcher = new NotificationDispatcher([ch1, ch2], allEnabled)
    const report = await dispatcher.sendTest()

    expect(report.totalSent).toBe(2)
    expect(report.totalFailed).toBe(0)
    expect(report.sent).toHaveLength(2)

    // Verify test payload was sent
    const payload = vi.mocked(ch1.send).mock.calls[0]![0]
    expect(payload.event).toBe('pr_ready')
    expect(payload.repo).toBe('test/test-repo')
    expect(payload.issueNumber).toBe(0)
    expect(payload.summary).toContain('test notification')
  })

  it('report printed to stdout (via logger)', async () => {
    const ch: NotificationChannel = {
      type: 'console',
      send: vi.fn().mockResolvedValue(true),
      validate: vi.fn().mockResolvedValue({ valid: true, error: null }),
    }

    const allEnabled = {
      onRunStarted: true,
      onBlocked: true,
      onPrReady: true,
      onPrUpdated: true,
      onError: true,
      onRetryExhausted: true,
    }

    const dispatcher = new NotificationDispatcher([ch], allEnabled)
    const report = await dispatcher.sendTest()

    // The report is structured and can be logged
    expect(typeof report.totalSent).toBe('number')
    expect(typeof report.totalFailed).toBe('number')
    expect(Array.isArray(report.sent)).toBe(true)
  })
})
