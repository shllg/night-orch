import { describe, it, expect, vi, beforeEach } from 'vitest'
import { discoverEligibleIssues, isIssueEligibleForRepo, type DiscoveredIssue } from '../../src/discovery/discover.js'
import type { ForgeAdapter, ForgeIssue } from '../../src/forge/types.js'
import type { LeaseManager } from '../../src/state/leases.js'
import type { RepoConfig } from '../../src/config/schema.js'

// Suppress logger output in tests
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

function makeIssue(overrides: Partial<ForgeIssue> = {}): ForgeIssue {
  return {
    number: 1,
    nodeId: 'MDU6SXNzdWUx',
    repo: 'org/repo',
    title: 'Test issue',
    body: 'Fix the thing',
    labels: ['no:ready'],
    assignees: [],
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/org/repo/issues/1',
    ...overrides,
  }
}

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: {
      ready: ['no:ready'],
      running: 'no:running',
      blocked: ['no:blocked', 'no:needs-human'],
      needsHuman: 'no:needs-human',
      reviewReady: 'no:review-ready',
      error: 'no:error',
      retry: 'no:retry',
      planning: 'no:planning',
      mergeQueued: 'no:merge-queued',
      merging: 'no:merging',
      mergeFailed: 'no:merge-failed',
    },
    defaults: {
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
      doneMode: 'pr-ready',
      notifyPriority: 'normal',
      prMentions: [],
    },
    verify: [],
    selectors: {
      includeLabelsAny: ['no:ready'],
      excludeLabelsAny: ['no:blocked'],
    },
    agents: {},
    linkedProjects: [],
    ...overrides,
  } as RepoConfig
}

function makeMockForge(issues: ForgeIssue[]): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn().mockResolvedValue(issues),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    commentOnIssue: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
  }
}

function makeMockLeaseManager(leasedIssues: Set<number> = new Set()): LeaseManager {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    isLeased: vi.fn((repo: string, issueNumber: number) => leasedIssues.has(issueNumber)),
    cleanExpired: vi.fn(),
  } as unknown as LeaseManager
}

describe('discoverEligibleIssues', () => {
  it('returns issues that pass selector and are not leased', async () => {
    const issues = [
      makeIssue({ number: 1, labels: ['no:ready'] }),
      makeIssue({ number: 2, labels: ['no:ready'] }),
      makeIssue({ number: 3, labels: ['no:ready'] }),
    ]
    const forge = makeMockForge(issues)
    const leaseManager = makeMockLeaseManager(new Set([2]))

    const result = await discoverEligibleIssues(makeRepoConfig(), forge, leaseManager)

    expect(result).toHaveLength(2)
    expect(result.map((d) => d.issue.number)).toEqual([1, 3])
  })

  it('excludes issues with exclude labels', async () => {
    const issues = [
      makeIssue({ number: 1, labels: ['no:ready'] }),
      makeIssue({ number: 2, labels: ['no:ready', 'no:blocked'] }),
    ]
    const forge = makeMockForge(issues)
    const leaseManager = makeMockLeaseManager()

    const result = await discoverEligibleIssues(makeRepoConfig(), forge, leaseManager)

    expect(result).toHaveLength(1)
    expect(result[0]!.issue.number).toBe(1)
  })

  it('returns empty array when no issues match', async () => {
    const forge = makeMockForge([])
    const leaseManager = makeMockLeaseManager()

    const result = await discoverEligibleIssues(makeRepoConfig(), forge, leaseManager)

    expect(result).toEqual([])
  })

  it('triages each issue', async () => {
    const issues = [
      makeIssue({ number: 1, labels: ['no:ready', 'bug'], body: 'Short' }),
      makeIssue({ number: 2, labels: ['no:ready', 'refactor'], body: 'Major refactoring' }),
    ]
    const forge = makeMockForge(issues)
    const leaseManager = makeMockLeaseManager()

    const result = await discoverEligibleIssues(makeRepoConfig(), forge, leaseManager)

    expect(result).toHaveLength(2)
    // Each result has a triage
    for (const d of result) {
      expect(d.triage).toHaveProperty('level')
      expect(d.triage).toHaveProperty('reason')
      expect(['trivial', 'standard', 'architectural']).toContain(d.triage.level)
    }
  })

  it('sorts trivial first, standard second, architectural last', async () => {
    const issues = [
      makeIssue({ number: 1, labels: ['no:ready', 'refactor'], body: 'Big change' }), // architectural
      makeIssue({ number: 2, labels: ['no:ready', 'enhancement'], body: 'A'.repeat(300) }), // standard
      makeIssue({ number: 3, labels: ['no:ready', 'bug'], body: 'Typo' }), // trivial
    ]
    const forge = makeMockForge(issues)
    const leaseManager = makeMockLeaseManager()

    const result = await discoverEligibleIssues(makeRepoConfig(), forge, leaseManager)

    expect(result).toHaveLength(3)
    expect(result[0]!.triage.level).toBe('trivial')
    expect(result[1]!.triage.level).toBe('standard')
    expect(result[2]!.triage.level).toBe('architectural')
  })

  it('attaches repoConfig to each discovered issue', async () => {
    const issues = [makeIssue({ number: 1, labels: ['no:ready'] })]
    const forge = makeMockForge(issues)
    const leaseManager = makeMockLeaseManager()
    const config = makeRepoConfig()

    const result = await discoverEligibleIssues(config, forge, leaseManager)

    expect(result[0]!.repoConfig).toBe(config)
  })

  it('calls forge.listEligibleIssues with the repo config', async () => {
    const forge = makeMockForge([])
    const leaseManager = makeMockLeaseManager()
    const config = makeRepoConfig()

    await discoverEligibleIssues(config, forge, leaseManager)

    expect(forge.listEligibleIssues).toHaveBeenCalledWith(config)
  })

  it('checks lease status for each eligible issue', async () => {
    const issues = [
      makeIssue({ number: 1, labels: ['no:ready'] }),
      makeIssue({ number: 2, labels: ['no:ready'] }),
    ]
    const forge = makeMockForge(issues)
    const leaseManager = makeMockLeaseManager()

    await discoverEligibleIssues(makeRepoConfig(), forge, leaseManager)

    expect(leaseManager.isLeased).toHaveBeenCalledWith('org/repo', 1)
    expect(leaseManager.isLeased).toHaveBeenCalledWith('org/repo', 2)
  })

  it('uses issue.repo when checking leases and storing issueRepo', async () => {
    const issue = makeIssue({
      number: 7,
      repo: 'org/tracker',
      url: 'https://github.com/org/tracker/issues/7',
      labels: ['no:ready'],
    })
    const forge = makeMockForge([issue])
    const leaseManager = makeMockLeaseManager()

    const result = await discoverEligibleIssues(makeRepoConfig(), forge, leaseManager)

    expect(leaseManager.isLeased).toHaveBeenCalledWith('org/tracker', 7)
    expect(result[0]?.issueRepo).toBe('org/tracker')
  })

  it('applies kanban selectors when trigger label is present', () => {
    const repoConfig = makeRepoConfig({
      selectors: {
        includeLabelsAny: ['no:ready'],
        excludeLabelsAny: ['no:blocked'],
      },
      kanban: {
        triggerLabel: 'flow:kanban',
        labels: {
          ready: ['kanban:todo'],
          running: 'kanban:doing',
          blocked: 'kanban:blocked',
          needsHuman: 'kanban:needs-human',
          reviewReady: 'kanban:review',
          error: 'kanban:error',
          retry: 'kanban:retry',
          planning: 'kanban:planning',
          mergeQueued: 'kanban:merge-queued',
          merging: 'kanban:merging',
          mergeFailed: 'kanban:merge-failed',
        },
      },
    })

    const kanbanEligible = makeIssue({ labels: ['flow:kanban', 'kanban:todo'] })
    const nonKanbanReady = makeIssue({ labels: ['flow:kanban', 'no:ready'] })

    expect(isIssueEligibleForRepo(kanbanEligible, repoConfig)).toBe(true)
    expect(isIssueEligibleForRepo(nonKanbanReady, repoConfig)).toBe(false)
  })

  it('handles all issues being leased', async () => {
    const issues = [
      makeIssue({ number: 1, labels: ['no:ready'] }),
      makeIssue({ number: 2, labels: ['no:ready'] }),
    ]
    const forge = makeMockForge(issues)
    const leaseManager = makeMockLeaseManager(new Set([1, 2]))

    const result = await discoverEligibleIssues(makeRepoConfig(), forge, leaseManager)

    expect(result).toEqual([])
  })
})
