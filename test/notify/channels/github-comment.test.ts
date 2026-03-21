import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitHubCommentChannel } from '../../../src/notify/channels/github-comment.js'
import type { ForgeAdapter } from '../../../src/forge/types.js'
import type { NotificationPayload } from '../../../src/notify/types.js'

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
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
    reviewSummary: 'APPROVED: Looks good',
    iterationCount: 1,
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makeMockForge(): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    validateAuth: vi.fn().mockResolvedValue({ user: 'bot', scopes: ['repo'] }),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
  }
}

describe('GitHubCommentChannel', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('posts formatted comment via ForgeAdapter', async () => {
    const forge = makeMockForge()
    const channel = new GitHubCommentChannel(forge)

    const result = await channel.send(makePayload())

    expect(result).toBe(true)
    expect(forge.commentOnIssue).toHaveBeenCalledWith('org/repo', 42, expect.stringContaining('pr ready'))
    const body = vi.mocked(forge.commentOnIssue).mock.calls[0]![2]
    expect(body).toContain('Fixed the login timeout')
    expect(body).toContain('https://github.com/org/repo/pull/10')
  })

  it('includes blocking reason when present', async () => {
    const forge = makeMockForge()
    const channel = new GitHubCommentChannel(forge)

    await channel.send(makePayload({ blockingReason: 'Max iterations exceeded' }))

    const body = vi.mocked(forge.commentOnIssue).mock.calls[0]![2]
    expect(body).toContain('Max iterations exceeded')
  })

  it('skips when no issue number', async () => {
    const forge = makeMockForge()
    const channel = new GitHubCommentChannel(forge)

    const result = await channel.send(makePayload({ issueNumber: 0 }))

    expect(result).toBe(true) // not an error, just skipped
    expect(forge.commentOnIssue).not.toHaveBeenCalled()
  })

  it('returns false on comment failure', async () => {
    const forge = makeMockForge()
    vi.mocked(forge.commentOnIssue).mockRejectedValue(new Error('API error'))
    const channel = new GitHubCommentChannel(forge)

    const result = await channel.send(makePayload())

    expect(result).toBe(false)
  })

  it('has type "github-comment"', () => {
    const channel = new GitHubCommentChannel(makeMockForge())
    expect(channel.type).toBe('github-comment')
  })

  it('validate checks auth', async () => {
    const forge = makeMockForge()
    const channel = new GitHubCommentChannel(forge)

    const result = await channel.validate()

    expect(result.valid).toBe(true)
    expect(forge.validateAuth).toHaveBeenCalled()
  })

  it('validate returns invalid when auth fails', async () => {
    const forge = makeMockForge()
    vi.mocked(forge.validateAuth).mockRejectedValue(new Error('Bad credentials'))
    const channel = new GitHubCommentChannel(forge)

    const result = await channel.validate()

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Bad credentials')
  })
})
