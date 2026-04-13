import { describe, it, expect, vi } from 'vitest'
import { scanForReactions } from '../../src/reactions/scanner.js'
import type { ForgeAdapter, PRCheckStatus, ForgePRReview, ForgePRReviewComment } from '../../src/forge/types.js'
import type { ReactionCursor } from '../../src/reactions/types.js'

function makeForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    commentOnIssue: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn(),
    updateComment: vi.fn(),
    listPRReviews: vi.fn().mockResolvedValue([]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    ...overrides,
  } as unknown as ForgeAdapter
}

const emptyCursor: ReactionCursor = {
  lastReviewId: 0,
  lastCommentId: 0,
  lastCheckConclusion: null,
  lastMergeableState: null,
}

describe('scanForReactions', () => {
  it('detects CI failure', async () => {
    const checkStatus: PRCheckStatus = {
      overall: 'failure',
      checks: [
        { name: 'tests', conclusion: 'failure', detailsUrl: 'https://ci/1' },
        { name: 'lint', conclusion: 'success', detailsUrl: null },
      ],
    }
    const forge = makeForge({
      getPRCheckStatus: vi.fn().mockResolvedValue(checkStatus),
    })

    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', emptyCursor)

    expect(result.reactions).toHaveLength(1)
    expect(result.reactions[0]!.type).toBe('ci_failure')
    expect(result.reactions[0]!.summary).toContain('tests')
    expect(result.cursor.lastCheckConclusion).toBe('failure')
  })

  it('does not re-react to same CI failure', async () => {
    const checkStatus: PRCheckStatus = {
      overall: 'failure',
      checks: [{ name: 'tests', conclusion: 'failure', detailsUrl: null }],
    }
    const forge = makeForge({
      getPRCheckStatus: vi.fn().mockResolvedValue(checkStatus),
    })

    const cursor: ReactionCursor = { ...emptyCursor, lastCheckConclusion: 'failure' }
    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', cursor)

    // Should NOT react because lastCheckConclusion was already 'failure'
    const ciReactions = result.reactions.filter((r) => r.type === 'ci_failure')
    expect(ciReactions).toHaveLength(0)
  })

  it('detects human review with changes_requested', async () => {
    const reviews: ForgePRReview[] = [
      { id: 10, user: 'human', state: 'changes_requested', body: 'Please fix the tests', submittedAt: '' },
    ]
    const forge = makeForge({
      listPRReviews: vi.fn().mockResolvedValue(reviews),
    })

    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', emptyCursor)

    expect(result.reactions.some((r) => r.type === 'human_review')).toBe(true)
    expect(result.cursor.lastReviewId).toBe(10)
  })

  it('ignores bot reviews', async () => {
    const reviews: ForgePRReview[] = [
      { id: 10, user: 'bot', state: 'commented', body: 'Automated review', submittedAt: '' },
    ]
    const forge = makeForge({
      listPRReviews: vi.fn().mockResolvedValue(reviews),
    })

    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', emptyCursor)

    const humanReactions = result.reactions.filter((r) => r.type === 'human_review')
    expect(humanReactions).toHaveLength(0)
  })

  it('detects new inline review comments', async () => {
    const comments: ForgePRReviewComment[] = [
      { id: 20, user: 'reviewer', body: 'This needs null check', path: 'src/a.ts', line: 10, createdAt: '' },
    ]
    const forge = makeForge({
      listPRReviewComments: vi.fn().mockResolvedValue(comments),
    })

    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', emptyCursor)

    expect(result.reactions.some((r) => r.type === 'review_comment')).toBe(true)
    expect(result.cursor.lastCommentId).toBe(20)
  })

  it('skips already-seen comments', async () => {
    const comments: ForgePRReviewComment[] = [
      { id: 5, user: 'reviewer', body: 'Old comment', path: 'src/a.ts', line: 1, createdAt: '' },
    ]
    const forge = makeForge({
      listPRReviewComments: vi.fn().mockResolvedValue(comments),
    })

    const cursor: ReactionCursor = { ...emptyCursor, lastCommentId: 10 }
    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', cursor)

    const commentReactions = result.reactions.filter((r) => r.type === 'review_comment')
    expect(commentReactions).toHaveLength(0)
  })

  it('returns empty reactions when nothing new', async () => {
    const forge = makeForge()
    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', emptyCursor)
    expect(result.reactions).toHaveLength(0)
  })

  it('detects merge conflicts when PR is not mergeable', async () => {
    const forge = makeForge({
      getPR: vi.fn().mockResolvedValue({
        number: 1,
        title: 'Test PR',
        body: '',
        state: 'open',
        mergeable: false,
        headBranch: 'feature',
        headSha: 'abc123',
        baseBranch: 'main',
        url: 'https://example.invalid/pr/1',
      }),
    })

    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', emptyCursor)

    const conflictReaction = result.reactions.find((r) => r.type === 'merge_conflict')
    expect(conflictReaction).toBeDefined()
    expect(conflictReaction?.summary).toContain('merge conflicts')
    expect(result.cursor.lastMergeableState).toBe('conflicting')
  })

  it('does not re-react when PR is already known to be conflicting', async () => {
    const forge = makeForge({
      getPR: vi.fn().mockResolvedValue({
        number: 1,
        title: 'Test PR',
        body: '',
        state: 'open',
        mergeable: false,
        headBranch: 'feature',
        headSha: 'abc123',
        baseBranch: 'main',
        url: 'https://example.invalid/pr/1',
      }),
    })

    const cursor: ReactionCursor = { ...emptyCursor, lastMergeableState: 'conflicting' }
    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', cursor)

    const conflictReactions = result.reactions.filter((r) => r.type === 'merge_conflict')
    expect(conflictReactions).toHaveLength(0)
    expect(result.cursor.lastMergeableState).toBe('conflicting')
  })

  it('re-reacts on transition from mergeable back to conflicting', async () => {
    const forge = makeForge({
      getPR: vi.fn().mockResolvedValue({
        number: 1,
        title: 'Test PR',
        body: '',
        state: 'open',
        mergeable: false,
        headBranch: 'feature',
        headSha: 'abc123',
        baseBranch: 'main',
        url: 'https://example.invalid/pr/1',
      }),
    })

    const cursor: ReactionCursor = { ...emptyCursor, lastMergeableState: 'mergeable' }
    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', cursor)

    const conflictReactions = result.reactions.filter((r) => r.type === 'merge_conflict')
    expect(conflictReactions).toHaveLength(1)
  })

  it('clears merge_conflict cursor when PR becomes mergeable again', async () => {
    const forge = makeForge({
      getPR: vi.fn().mockResolvedValue({
        number: 1,
        title: 'Test PR',
        body: '',
        state: 'open',
        mergeable: true,
        headBranch: 'feature',
        headSha: 'abc123',
        baseBranch: 'main',
        url: 'https://example.invalid/pr/1',
      }),
    })

    const cursor: ReactionCursor = { ...emptyCursor, lastMergeableState: 'conflicting' }
    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', cursor)

    expect(result.reactions.filter((r) => r.type === 'merge_conflict')).toHaveLength(0)
    expect(result.cursor.lastMergeableState).toBe('mergeable')
  })

  it('leaves lastMergeableState null when PR cannot be fetched', async () => {
    const forge = makeForge({
      getPR: vi.fn().mockRejectedValue(new Error('boom')),
    })

    const result = await scanForReactions(forge, 'org/repo', 1, 42, 'bot', emptyCursor)

    expect(result.reactions.filter((r) => r.type === 'merge_conflict')).toHaveLength(0)
    expect(result.cursor.lastMergeableState).toBeNull()
  })
})
