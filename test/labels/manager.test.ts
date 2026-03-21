import { describe, it, expect, vi, beforeEach } from 'vitest'
import { transitionLabels } from '../../src/labels/manager.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { LabelConfig } from '../../src/labels/transitions.js'

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
  blocked: ['orch:blocked', 'orch:needs-human'],
  reviewReady: 'orch:review-ready',
  error: 'orch:error',
  retry: 'orch:retry',
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

  it('handles transition to blocked — adds blocked labels', async () => {
    const forge = makeMockForge()

    await transitionLabels(forge, 'org/repo', 1, ['orch:running'], 'running', 'blocked', labelConfig)

    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:blocked', 'orch:needs-human'])
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:running'])
  })
})
