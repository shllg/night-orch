import { describe, it, expect, vi } from 'vitest'
import { markerTag, upsertBotComment } from '../../src/forge/bot-comment.js'
import { handlePostPublishReview } from '../../src/loop/post-publish.js'
import type { WorkerStep } from '../../src/loop/workflow.js'
import type { ReviewerOutput } from '../../src/workers/types.js'
import type { ForgeAdapter, ForgeComment } from '../../src/forge/types.js'
import type { RunContext } from '../../src/loop/types.js'
import { makeTestConfig } from '../helpers/factories.js'

/**
 * Phase 4 acceptance: external review comments posted on the issue must use
 * the configured `commentPrefix` (falling back to `[night-orch]`) AND must be
 * deduped per-attempt via the `<!-- night-orch:${stepId}-${runId} -->`
 * marker. Drive the post-publish review handler so the assertion observes the
 * comment body sent to the forge.
 */
describe('external review comment — prefix and marker contract', () => {
  describe('post-publish external review issue comment', () => {
    it('posts the configured commentPrefix on the verdict line', async () => {
      const forge = makeForge([])

      await handlePostPublishReview({
        ctx: makeCtx(),
        step: stepWith({ commentPrefix: '[night-orch][cr]' }),
        review: reviewFixture(),
        forge,
        issueRepo: 'org/repo',
        issueNumber: 7,
        prNumber: 42,
        botUser: 'orch-bot',
      })

      const body = commentBodyFrom(forge.commentOnIssue)
      expect(body.split('\n')).toEqual([
        '<!-- night-orch:cr-attempt-1 -->',
        '[night-orch][cr] External review: CHANGES_REQUIRED',
        '',
        'Missing null-check before dereferencing user',
        '',
        'Findings:',
        '- [major] Guard against null user',
        '  Suggested fix: Add an early-return when user is null',
      ])
    })

    it('defaults the posted verdict line prefix to [night-orch] when not configured', async () => {
      const forge = makeForge([])

      await handlePostPublishReview({
        ctx: makeCtx(),
        step: stepWith({}),
        review: reviewFixture(),
        forge,
        issueRepo: 'org/repo',
        issueNumber: 7,
        prNumber: 42,
        botUser: 'orch-bot',
      })

      const body = commentBodyFrom(forge.commentOnIssue)
      expect(body.split('\n')[1]).toBe('[night-orch] External review: CHANGES_REQUIRED')
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

function makeCtx(): RunContext {
  const config = makeTestConfig()
  return {
    runId: 'attempt-1',
    repo: 'org/repo',
    issueRepo: 'org/repo',
    issueNumber: 7,
    issue: { number: 7, nodeId: 'issue-node', title: 'Issue', body: '', labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: config.repos[0]!,
    roles: { planner: 'codex', coder: 'codex', reviewer: 'codex' },
    triageResult: { level: 'standard', reason: 'test' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/7-fix',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: 'diff',
    verifyResults: [],
    reviewResults: {},
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'completed',
    terminalStatus: 'publish',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh',
    blockReason: null,
    prReviewFeedback: null,
    diffError: null,
    emptyDiffRetries: 0,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
  }
}

function makeForge(existing: ForgeComment[]): ForgeAdapter {
  return {
    listIssueComments: vi.fn().mockResolvedValue(existing),
    updateComment: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
  } as unknown as ForgeAdapter
}

function commentBodyFrom(commentOnIssue: ForgeAdapter['commentOnIssue']): string {
  const body = vi.mocked(commentOnIssue).mock.calls[0]?.[2]
  expect(body).toBeTypeOf('string')
  return body!
}
