import { describe, expect, it, vi } from 'vitest'
import type { ForgeAdapter, ForgeIssue } from '../../src/forge/types.js'
import { RunStateController } from '../../src/poller/run-state-controller.js'
import type { PollerNotifier } from '../../src/poller/notify-dispatcher.js'
import type { RunManager } from '../../src/state/runs.js'
import { makeTestRepoConfig } from '../helpers/factories.js'

function makeIssue(labels: string[] = ['no:running']): ForgeIssue {
  return {
    number: 42,
    nodeId: 'issue-node',
    repo: 'org/repo',
    title: 'Fix AFK path',
    body: '',
    labels,
    assignees: [],
    state: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    url: 'https://example.com/org/repo/issues/42',
  }
}

function makeForge(issue: ForgeIssue): ForgeAdapter {
  return {
    getIssue: vi.fn().mockResolvedValue(issue),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    commentOnIssue: vi.fn(),
    listEligibleIssues: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn().mockResolvedValue([]),
    updateComment: vi.fn(),
    listPRReviews: vi.fn(),
    listPRReviewComments: vi.fn(),
    mergePR: vi.fn(),
    closePR: vi.fn(),
  } as unknown as ForgeAdapter
}

describe('RunStateController', () => {
  it('marks a run blocked through state, labels, status comment, and notification', async () => {
    const issue = makeIssue()
    const forge = makeForge(issue)
    const runManager = { transitionRunState: vi.fn() } as unknown as RunManager
    const pollerNotifier = { blocked: vi.fn() } as unknown as PollerNotifier
    const controller = new RunStateController({
      forge,
      repoConfig: makeTestRepoConfig(),
      issueRepo: 'org/repo',
      issue,
      runManager,
      pollerNotifier,
      botUser: '',
    })

    await controller.markBlocked('run-1', {
      from: 'running',
      fields: {
        blockReason: 'verify_config',
        lastError: 'Worktree is dirty',
      },
      labelReason: { type: 'verifyConfig', detail: 'Worktree is dirty' },
      comment: {
        body: 'Blocked: Worktree is dirty',
        warnMessage: 'Failed to post dirty worktree status comment',
      },
      notification: {
        summary: 'Worktree is dirty',
        blockingReason: 'verify_config',
      },
    })

    expect(runManager.transitionRunState).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'blocked',
        blockReason: 'verify_config',
        lastError: 'Worktree is dirty',
        endedAt: expect.any(String),
      }),
    )
    expect(forge.getIssue).toHaveBeenCalledWith('org/repo', 42)
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 42, ['no:running'])
    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 42, ['no:blocked'])
    expect(forge.commentOnIssue).toHaveBeenCalledWith('org/repo', 42, 'Blocked: Worktree is dirty')
    expect(pollerNotifier.blocked).toHaveBeenCalledWith('org/repo', issue, {
      summary: 'Worktree is dirty',
      blockingReason: 'verify_config',
    })
  })
})
