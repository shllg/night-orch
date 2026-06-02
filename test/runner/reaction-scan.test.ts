import { describe, it, expect, vi } from 'vitest'
import { scanAndHandleReactions } from '../../src/runner/reaction-scan.js'
import { createOrchestrationCache } from '../../src/runner/orchestration-cache.js'
import type { Config } from '../../src/config/schema.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { RunManager } from '../../src/state/runs.js'

const mockScanForReactions = vi.fn()
const mockHandleReaction = vi.fn()

vi.mock('../../src/reactions/scanner.js', () => ({
  scanForReactions: (...args: unknown[]) => mockScanForReactions(...args),
}))

vi.mock('../../src/reactions/handler.js', () => ({
  handleReaction: (...args: unknown[]) => mockHandleReaction(...args),
}))

describe('scanAndHandleReactions', () => {
  it('passes mention and review-bot settings to the reaction scanner', async () => {
    mockScanForReactions.mockResolvedValue({
      reactions: [],
      cursor: {
        lastReviewId: 0,
        lastCommentId: 0,
        lastIssueCommentId: 0,
        lastCheckConclusion: null,
        lastMergeableState: null,
      },
    })
    const runManager = {
      getActive: () => [
        {
          id: 'run-1',
          repo: 'org/repo',
          issueNumber: 42,
          status: 'review_ready',
          prNumber: 9,
        },
      ],
    } as unknown as RunManager
    const config = {
      commentCommands: {
        enabled: true,
        requireCollaborator: true,
        acceptMentions: true,
        mentionAliases: ['@orch'],
        reviewBotAllowlist: ['coderabbitai[bot]'],
      },
    } as Config

    await scanAndHandleReactions({
      db: {} as never,
      forge: {} as ForgeAdapter,
      runManager,
      repoConfig: { repo: 'org/repo' } as Config['repos'][0],
      maxAttemptChainLength: 3,
      cache: createOrchestrationCache(),
      config,
      botUser: 'night-orch',
    })

    expect(mockScanForReactions).toHaveBeenCalledWith(
      {},
      'org/repo',
      9,
      42,
      undefined,
      {
        acceptMentions: true,
        requireCollaborator: true,
        mentionAliases: ['@orch'],
        botUser: 'night-orch',
        reviewBotAllowlist: ['coderabbitai[bot]'],
      },
    )
  })
})
