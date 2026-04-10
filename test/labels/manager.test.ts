import { describe, it, expect, vi, beforeEach } from 'vitest'
import { transitionLabels } from '../../src/labels/manager.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { LabelConfig } from '../../src/labels/transitions.js'
import type { BlockedReason } from '../../src/loop/state.js'

const reviewerBlockedReason: BlockedReason = { type: 'reviewerBlocked', summary: 'no' }
const costLimitReason: BlockedReason = {
  type: 'costLimit',
  limit: 'per-run',
  actualUsd: 12,
  limitUsd: 10,
}

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const labelConfig: LabelConfig = {
  ready: ['orch:ready'],
  running: 'orch:running',
  blocked: 'orch:blocked',
  needsHuman: 'orch:needs-human',
  reviewReady: 'orch:review-ready',
  error: 'orch:error',
  retry: 'orch:retry',
  planning: 'orch:planning',
  mergeQueued: 'orch:merge-queued',
  merging: 'orch:merging',
  mergeFailed: 'orch:merge-failed',
}

function makeMockForge(): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn(),
    updateComment: vi.fn(),
    listPRReviews: vi.fn(),
    listPRReviewComments: vi.fn(),
    mergePR: vi.fn(),
    closePR: vi.fn(),
  }
}

describe('transitionLabels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls forge.addLabels and forge.removeLabels correctly', async () => {
    const forge = makeMockForge()

    await transitionLabels(forge, 'org/repo', 1, ['orch:ready'], 'queued', 'running', labelConfig)

    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:running'])
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:ready'])
  })

  it('skips API calls when no labels change', async () => {
    const forge = makeMockForge()

    await transitionLabels(forge, 'org/repo', 1, ['orch:running'], 'running', 'running', labelConfig)

    expect(forge.addLabels).not.toHaveBeenCalled()
    expect(forge.removeLabels).not.toHaveBeenCalled()
  })

  it('only adds labels not already present', async () => {
    const forge = makeMockForge()

    // Already has running label
    await transitionLabels(forge, 'org/repo', 1, ['orch:ready', 'orch:running'], 'queued', 'running', labelConfig)

    // Should not try to add orch:running since it's already there
    expect(forge.addLabels).not.toHaveBeenCalled()
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:ready'])
  })

  it('only removes labels actually present', async () => {
    const forge = makeMockForge()

    // Does not have orch:ready — only running
    await transitionLabels(forge, 'org/repo', 1, ['orch:running'], 'running', 'error', labelConfig)

    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:error'])
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:running'])
  })

  it('addLabels failure is logged but does not throw', async () => {
    const forge = makeMockForge()
    vi.mocked(forge.addLabels).mockRejectedValue(new Error('API error'))

    await expect(
      transitionLabels(forge, 'org/repo', 1, ['orch:ready'], 'queued', 'running', labelConfig),
    ).resolves.toBeUndefined()

    // removeLabels should still be called
    expect(forge.removeLabels).toHaveBeenCalled()
  })

  it('removeLabels failure is logged but does not throw', async () => {
    const forge = makeMockForge()
    vi.mocked(forge.removeLabels).mockRejectedValue(new Error('API error'))

    await expect(
      transitionLabels(forge, 'org/repo', 1, ['orch:ready'], 'queued', 'running', labelConfig),
    ).resolves.toBeUndefined()
  })

  it('handles transition to completed — removes running + reviewReady', async () => {
    const forge = makeMockForge()

    await transitionLabels(forge, 'org/repo', 1, ['orch:running', 'orch:review-ready'], 'running', 'completed', labelConfig)

    expect(forge.addLabels).not.toHaveBeenCalled()
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 1, expect.arrayContaining(['orch:running', 'orch:review-ready']))
  })

  it('handles transition to blocked without blockReason — adds only blocked label', async () => {
    const forge = makeMockForge()

    await transitionLabels(forge, 'org/repo', 1, ['orch:running'], 'running', 'blocked', labelConfig)

    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:blocked'])
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:running'])
  })

  it('handles transition to blocked with reviewerBlocked — adds blocked + needsHuman', async () => {
    const forge = makeMockForge()

    await transitionLabels(forge, 'org/repo', 1, ['orch:running'], 'running', 'blocked', labelConfig, reviewerBlockedReason)

    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:blocked', 'orch:needs-human'])
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:running'])
  })

  it('handles transition to blocked with costLimit — adds only blocked label', async () => {
    const forge = makeMockForge()

    await transitionLabels(forge, 'org/repo', 1, ['orch:running'], 'running', 'blocked', labelConfig, costLimitReason)

    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:blocked'])
  })

  it('removes stale needsHuman label when blocked reason does not require humans', async () => {
    const forge = makeMockForge()

    await transitionLabels(
      forge,
      'org/repo',
      1,
      ['orch:running', 'orch:needs-human'],
      'running',
      'blocked',
      labelConfig,
      costLimitReason,
    )

    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:running', 'orch:needs-human'])
  })
})
