import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebhookChannel } from '../../../src/notify/channels/webhook.js'
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
    prUrl: null,
    prNumber: null,
    summary: 'Done',
    blockingReason: null,
    reviewSummary: null,
    iterationCount: 1,
    timestamp: '2026-01-01T00:00:00Z',
  }
}

describe('WebhookChannel', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends POST with correct JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = mockFetch

    const channel = new WebhookChannel('https://hooks.example.com/notify')
    const result = await channel.send(makePayload())

    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.example.com/notify',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body)
    expect(body.event).toBe('pr_ready')
    expect(body.repo).toBe('org/repo')
  })

  it('returns false on 4xx (no retry)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 })
    globalThis.fetch = mockFetch

    const channel = new WebhookChannel('https://hooks.example.com/notify')
    const result = await channel.send(makePayload())

    expect(result).toBe(false)
    // Only one call — no retry on 4xx
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('retries once on 5xx', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    globalThis.fetch = mockFetch

    const channel = new WebhookChannel('https://hooks.example.com/notify')
    const result = await channel.send(makePayload())

    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns false after 5xx retry fails', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
    globalThis.fetch = mockFetch

    const channel = new WebhookChannel('https://hooks.example.com/notify')
    const result = await channel.send(makePayload())

    expect(result).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns false on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

    const channel = new WebhookChannel('https://hooks.example.com/notify')
    const result = await channel.send(makePayload())

    expect(result).toBe(false)
  })

  it('validate returns invalid for empty URL', async () => {
    const channel = new WebhookChannel('')
    const result = await channel.validate()
    expect(result.valid).toBe(false)
  })

  it('validate returns invalid for malformed URL', async () => {
    const channel = new WebhookChannel('not-a-url')
    const result = await channel.validate()
    expect(result.valid).toBe(false)
  })

  it('validate returns valid for proper URL', async () => {
    const channel = new WebhookChannel('https://hooks.example.com')
    const result = await channel.validate()
    expect(result.valid).toBe(true)
  })
})
