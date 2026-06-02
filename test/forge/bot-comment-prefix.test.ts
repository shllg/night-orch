import { describe, it, expect, vi } from 'vitest'
import { markerTag, upsertBotComment } from '../../src/forge/bot-comment.js'
import { formatExternalReviewComment } from '../../src/loop/post-publish.js'
import type { WorkerStep } from '../../src/loop/workflow.js'
import type { ReviewerOutput } from '../../src/workers/types.js'
import type { ForgeAdapter, ForgeComment } from '../../src/forge/types.js'

/**
 * Phase 4 acceptance: external review comments posted on the issue must use
 * the configured `commentPrefix` (falling back to `[night-orch]`) AND must be
 * deduped per-attempt via the `<!-- night-orch:${stepId}-${runId} -->`
 * marker. The post-publish.test.ts integration touches both, but a dedicated
 * unit gives a single regression surface that survives refactors to the
 * orchestrator.
 */
describe('external review comment — prefix and marker contract', () => {
  describe('formatExternalReviewComment', () => {
    it('uses the configured commentPrefix on the verdict line', () => {
      const body = formatExternalReviewComment(stepWith({ commentPrefix: '[night-orch][cr]' }), reviewFixture())
      expect(body.split('\n')[0]).toBe('[night-orch][cr] External review: CHANGES_REQUIRED')
    })

    it('defaults the prefix to [night-orch] when not configured', () => {
      const body = formatExternalReviewComment(stepWith({}), reviewFixture())
      expect(body.split('\n')[0]).toBe('[night-orch] External review: CHANGES_REQUIRED')
    })

    it('renders findings with severity and optional suggested fix', () => {
      const body = formatExternalReviewComment(stepWith({}), reviewFixture())
      expect(body).toContain('- [major] Guard against null user')
      expect(body).toContain('  Suggested fix: Add an early-return when user is null')
    })

    it('omits the findings section when there are none', () => {
      const review: ReviewerOutput = { ...reviewFixture(), findings: [] }
      const body = formatExternalReviewComment(stepWith({}), review)
      expect(body).not.toContain('Findings:')
    })
  })

  describe('upsertBotComment marker dedup (per-attempt)', () => {
    it('updates the existing comment when the same step+attempt marker is seen again', async () => {
      const marker = markerTag('cr-attempt-1')
      const forge = makeForge([
        { id: 99, body: `${marker}\nFirst pass`, user: 'orch-bot', createdAt: '', updatedAt: '' },
      ])

      const result = await upsertBotComment(forge, 'org/repo', 7, marker, 'Second pass', 'orch-bot')

      expect(result.created).toBe(false)
      expect(forge.updateComment).toHaveBeenCalledWith('org/repo', 99, `${marker}\nSecond pass`)
      expect(forge.commentOnIssue).not.toHaveBeenCalled()
    })

    it('creates a new comment for a distinct attempt marker even when an older one exists', async () => {
      // Different runId => different marker => operator can see history per
      // attempt instead of having the latest attempt clobber the previous.
      const olderMarker = markerTag('cr-attempt-1')
      const newerMarker = markerTag('cr-attempt-2')
      const forge = makeForge([
        { id: 99, body: `${olderMarker}\nOlder findings`, user: 'orch-bot', createdAt: '', updatedAt: '' },
      ])

      const result = await upsertBotComment(forge, 'org/repo', 7, newerMarker, 'Fresh findings', 'orch-bot')

      expect(result.created).toBe(true)
      expect(forge.commentOnIssue).toHaveBeenCalledWith('org/repo', 7, `${newerMarker}\nFresh findings`)
      expect(forge.updateComment).not.toHaveBeenCalled()
    })

    it('does not match a marker authored by a different user (no spoofing)', async () => {
      const marker = markerTag('cr-attempt-1')
      const forge = makeForge([
        { id: 1, body: `${marker}\nSpoofed`, user: 'attacker', createdAt: '', updatedAt: '' },
      ])

      const result = await upsertBotComment(forge, 'org/repo', 7, marker, 'Real comment', 'orch-bot')

      expect(result.created).toBe(true)
      expect(forge.commentOnIssue).toHaveBeenCalled()
      expect(forge.updateComment).not.toHaveBeenCalled()
    })
  })
})

function stepWith(overrides: Partial<WorkerStep>): WorkerStep {
  return {
    type: 'worker',
    id: 'cr',
    role: 'reviewer',
    ...overrides,
  } as WorkerStep
}

function reviewFixture(): ReviewerOutput {
  return {
    verdict: 'CHANGES_REQUIRED',
    summary: 'Missing null-check before dereferencing user',
    findings: [
      {
        severity: 'major',
        category: 'correctness',
        location: 'src/auth.ts:42',
        message: 'Guard against null user',
        suggestedFix: 'Add an early-return when user is null',
      },
    ],
    definitionOfDoneCheck: {
      issueAddressed: true,
      testsPassing: true,
      noBlockingFindings: false,
    },
  }
}

function makeForge(existing: ForgeComment[]): ForgeAdapter {
  return {
    listIssueComments: vi.fn().mockResolvedValue(existing),
    updateComment: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
  } as unknown as ForgeAdapter
}
