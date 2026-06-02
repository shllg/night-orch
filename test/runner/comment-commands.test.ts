import { describe, it, expect, vi } from 'vitest'
import { collectCommentSources, processCommentCommands } from '../../src/runner/comment-commands.js'
import { parseOrchCommands } from '../../src/discovery/commands.js'
import type { Config } from '../../src/config/schema.js'
import type { ForgeAdapter, ForgeComment, ForgePRReview, ForgePRReviewComment } from '../../src/forge/types.js'
import { LeaseManager } from '../../src/state/leases.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { createOrchestrationCache } from '../../src/runner/orchestration-cache.js'
import { makeTestConfig, makeTestRepoConfig } from '../helpers/factories.js'

function makeForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listIssueComments: vi.fn().mockResolvedValue([]),
    listPRReviews: vi.fn().mockResolvedValue([]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ForgeAdapter
}

const EPOCH = '1970-01-01T00:00:00Z'

describe('collectCommentSources', () => {
  it('returns only issue comments when PR number is null', async () => {
    const issueComments: ForgeComment[] = [
      { id: 1, body: '/orch continue', user: 'shllg', createdAt: '2026-04-13T13:00:00Z', updatedAt: '2026-04-13T13:00:00Z' },
    ]
    const forge = makeForge({ listIssueComments: vi.fn().mockResolvedValue(issueComments) })

    const out = await collectCommentSources(forge, 'org/repo', 5, null)

    expect(out).toHaveLength(1)
    expect(forge.listPRReviews).not.toHaveBeenCalled()
    expect(forge.listPRReviewComments).not.toHaveBeenCalled()
  })

  it('merges issue comments, PR review bodies, and inline PR review comments when a PR exists', async () => {
    const issueComments: ForgeComment[] = [
      { id: 1, body: 'issue body', user: 'shllg', createdAt: '2026-04-13T12:00:00Z', updatedAt: '2026-04-13T12:00:00Z' },
    ]
    const reviews: ForgePRReview[] = [
      { id: 10, user: 'shllg', state: 'commented', body: '/orch continue', submittedAt: '2026-04-13T13:00:00Z' },
    ]
    const reviewComments: ForgePRReviewComment[] = [
      { id: 20, user: 'shllg', body: '/orch retry', path: 'a.ts', line: 1, createdAt: '2026-04-13T13:05:00Z' },
    ]
    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue(issueComments),
      listPRReviews: vi.fn().mockResolvedValue(reviews),
      listPRReviewComments: vi.fn().mockResolvedValue(reviewComments),
    })

    const out = await collectCommentSources(forge, 'org/repo', 5, 166)

    expect(out).toHaveLength(3)
    expect(out.map((c) => c.id).sort()).toEqual([1, 10, 20])

    const parsed = parseOrchCommands(out, EPOCH)
    const verbs = parsed.map((p) => p.command.type).sort()
    expect(verbs).toEqual(['continue', 'retry'])
  })

  it('drops review bodies with empty/whitespace body', async () => {
    const reviews: ForgePRReview[] = [
      { id: 10, user: 'shllg', state: 'commented', body: '', submittedAt: '2026-04-13T13:00:00Z' },
      { id: 11, user: 'shllg', state: 'commented', body: '   ', submittedAt: '2026-04-13T13:00:00Z' },
    ]
    const forge = makeForge({ listPRReviews: vi.fn().mockResolvedValue(reviews) })

    const out = await collectCommentSources(forge, 'org/repo', 5, 166)

    expect(out).toHaveLength(0)
  })

  it('filters out bot-authored sources by marker, regardless of user identity', async () => {
    // Single-user deployment: bot and human share the same GitHub identity.
    // The bot's own status comment must be filtered by marker, not by user.
    const issueComments: ForgeComment[] = [
      {
        id: 1,
        body: '<!-- night-orch:status -->\n**night-orch**: continued',
        user: 'shllg',
        createdAt: '2026-04-13T13:00:00Z',
        updatedAt: '2026-04-13T13:00:00Z',
      },
      {
        id: 2,
        body: '/orch continue',
        user: 'shllg',
        createdAt: '2026-04-13T13:01:00Z',
        updatedAt: '2026-04-13T13:01:00Z',
      },
    ]
    const forge = makeForge({ listIssueComments: vi.fn().mockResolvedValue(issueComments) })

    const out = await collectCommentSources(forge, 'org/repo', 5, null)

    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe(2)
  })

  it('swallows PR-side fetch failures without losing issue comments', async () => {
    const issueComments: ForgeComment[] = [
      { id: 1, body: '/orch continue', user: 'shllg', createdAt: '2026-04-13T13:00:00Z', updatedAt: '2026-04-13T13:00:00Z' },
    ]
    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue(issueComments),
      listPRReviews: vi.fn().mockRejectedValue(new Error('boom')),
      listPRReviewComments: vi.fn().mockRejectedValue(new Error('boom')),
    })

    const out = await collectCommentSources(forge, 'org/repo', 5, 166)

    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe(1)
  })
})

describe('processCommentCommands', () => {
  it('enforces collaborator check when commentCommands is undefined', async () => {
    const db = initDatabase(':memory:')
    const runManager = new RunManager(db)
    const leaseManager = new LeaseManager(db)
    const repoConfig = makeTestRepoConfig({ repo: 'org/repo' })
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 7,
      issueNodeId: 'node-7',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.updateLifecycle(run.id, { status: 'review_ready' })

    const isCollaborator = vi.fn().mockResolvedValue(false)
    const forge = makeForge({
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 1,
          user: 'random-attacker',
          body: '/orch rebase',
          createdAt: '2026-06-02T09:00:00Z',
          updatedAt: '2026-06-02T09:00:00Z',
        },
      ]),
      isCollaborator,
    })
    const config = {
      ...makeTestConfig({ repos: [repoConfig] }),
      commentCommands: undefined,
    } as unknown as Config

    await processCommentCommands({
      config,
      db,
      forge,
      runManager,
      leaseManager,
      repoConfig,
      botUser: 'orch-bot',
      cache: createOrchestrationCache(),
    })

    expect(isCollaborator).toHaveBeenCalledWith('org/repo', 'random-attacker')
  })
})
