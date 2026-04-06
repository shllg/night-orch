import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lookup } from 'node:dns/promises'
import type { NotificationPayload } from '../../../src/notify/types.js'
import { DiscordChannel } from '../../../src/notify/channels/discord.js'

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

function makePayload(): NotificationPayload {
  return {
    event: 'blocked',
    repo: 'org/repo',
    issueNumber: 42,
    issueTitle: 'Fix login',
    issueUrl: 'https://github.com/org/repo/issues/42',
    state: 'blocked',
    prUrl: 'https://github.com/org/repo/pull/99',
    prNumber: 99,
    summary: 'Run blocked and needs human review',
    blockingReason: 'Reviewer requested architecture clarification',
    reviewSummary: 'CHANGES_REQUIRED: update token handling',
    iterationCount: 2,
    timestamp: '2026-01-01T00:00:00Z',
  }
}

describe('DiscordChannel', () => {
  const originalFetch = globalThis.fetch
  const mockLookup = vi.mocked(lookup)

  beforeEach(() => {
    vi.clearAllMocks()
    mockLookup.mockResolvedValue([{ address: '198.51.100.10', family: 4 }] as never)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends Discord embed payload', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    globalThis.fetch = mockFetch

    const channel = new DiscordChannel('https://discord.com/api/webhooks/abc/def')
    const result = await channel.send(makePayload())

    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockLookup).toHaveBeenCalledWith('discord.com', { all: true })
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body) as {
      allowed_mentions: { parse: string[] }
      embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }>
    }
    expect(body.allowed_mentions.parse).toEqual([])
    expect(Array.isArray(body.embeds)).toBe(true)
    expect(body.embeds[0]?.title).toContain('Action Required')
    expect(body.embeds[0]?.fields.some((field) => field.name === 'Pull Request')).toBe(true)
  })

  it('escapes markdown injection content and neutralizes mentions', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    globalThis.fetch = mockFetch
    const payload = makePayload()
    payload.issueTitle = 'x](https://evil.example) @everyone'
    payload.summary = 'Please review @everyone [fake](https://evil.example)'
    payload.blockingReason = 'Blocked by @here with ](https://evil.example)'
    payload.reviewSummary = 'CHANGES_REQUIRED ](https://evil.example)'

    const channel = new DiscordChannel('https://discord.com/api/webhooks/abc/def')
    const result = await channel.send(payload)

    expect(result).toBe(true)
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body) as {
      embeds: Array<{ description?: string; fields: Array<{ name: string; value: string }> }>
    }
    const issueField = body.embeds[0]?.fields.find((field) => field.name === 'Issue')?.value ?? ''
    const blockedField = body.embeds[0]?.fields.find((field) => field.name === 'Blocking Reason')?.value ?? ''

    expect(issueField).not.toContain('[#')
    expect(issueField).toContain('@\u200Beveryone')
    expect(blockedField).toContain('@\u200Bhere')
    expect(body.embeds[0]?.description).toContain('@\u200Beveryone')
    expect(body.embeds[0]?.description).not.toContain('@everyone')
  })

  it('returns false on 4xx (no retry)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 })
    globalThis.fetch = mockFetch

    const channel = new DiscordChannel('https://discord.com/api/webhooks/abc/def')
    const result = await channel.send(makePayload())

    expect(result).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('retries once on 5xx', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 204 })
    globalThis.fetch = mockFetch

    const channel = new DiscordChannel('https://discord.com/api/webhooks/abc/def')
    const result = await channel.send(makePayload())

    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns false if hostname resolves to private IP', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never)
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 })

    const channel = new DiscordChannel('https://discord.com/api/webhooks/abc/def')
    const result = await channel.send(makePayload())

    expect(result).toBe(false)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('validate returns invalid for non-https URL', async () => {
    const channel = new DiscordChannel('http://discord.com/api/webhooks/abc/def')
    const result = await channel.validate()

    expect(result.valid).toBe(false)
  })

  it('validate returns valid for proper Discord URL', async () => {
    const channel = new DiscordChannel('https://discord.com/api/webhooks/abc/def')
    const result = await channel.validate()

    expect(result.valid).toBe(true)
  })
})
