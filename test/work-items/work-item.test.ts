import { describe, it, expect } from 'vitest'
import { createWorkItemFromDiscoveredIssue } from '../../src/work-items/types.js'
import type { DiscoveredIssue } from '../../src/discovery/discover.js'
import type { RepoConfig } from '../../src/config/schema.js'
import type { ResolvedWorkflow } from '../../src/loop/workflow.js'

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    maxConcurrentRuns: 2,
    labels: {
      ready: ['no:ready'],
      running: 'no:running',
      blocked: 'no:blocked',
      needsHuman: 'no:needs-human',
      reviewReady: 'no:review-ready',
      error: 'no:error',
      retry: 'no:retry',
      planning: 'no:planning',
      mergeQueued: 'no:merge-queued',
      merging: 'no:merging',
      mergeFailed: 'no:merge-failed',
    },
    defaults: { planner: 'claude', coder: 'codex', reviewer: 'codex', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
    planning: { prdDirectory: 'docs/prd' },
    verify: [],
    selectors: { includeLabelsAny: ['no:ready'], excludeLabelsAny: [] },
    agents: {},
    labelConfig: {},
    ...overrides,
  } as RepoConfig
}

function makeDiscoveredIssue(): DiscoveredIssue {
  return {
    issueRepo: 'org/repo',
    issue: {
      number: 42,
      nodeId: 'I_abc',
      title: 'Implement staged verification',
      body: [
        '- [ ] add smoke checks',
        '- [x] keep backward compatibility',
        'depends on #7',
      ].join('\n'),
      labels: ['no:ready', 'enhancement'],
      assignees: [],
      state: 'open',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-02T00:00:00Z',
      url: 'https://github.com/org/repo/issues/42',
    },
    triage: { level: 'standard', reason: 'non-trivial' },
    repoConfig: makeRepoConfig(),
  }
}

const WORKFLOW: ResolvedWorkflow = {
  steps: [
    { type: 'worker', id: 'plan', role: 'planner' },
    { type: 'worker', id: 'code', role: 'coder' },
    { type: 'verify', id: 'verify', profile: 'strict' },
    { type: 'decide', id: 'decide', onIterate: 'code' },
  ],
}

describe('createWorkItemFromDiscoveredIssue', () => {
  it('maps issue data, workflow metadata, and runtime settings', () => {
    const repoConfig = makeRepoConfig({
      workflow: 'hardened',
      verificationProfile: 'strict',
    })
    const workItem = createWorkItemFromDiscoveredIssue(makeDiscoveredIssue(), repoConfig, WORKFLOW)

    expect(workItem.id).toBe('org/repo#42')
    expect(workItem.source.kind).toBe('github-issue')
    expect(workItem.workflow.configuredName).toBe('hardened')
    expect(workItem.workflow.resolvedStepIds).toEqual(['plan', 'code', 'verify', 'decide'])
    expect(workItem.verificationProfile).toBe('strict')
    expect(workItem.runtime.maxConcurrentRuns).toBe(2)
  })

  it('extracts acceptance criteria and dependency references', () => {
    const workItem = createWorkItemFromDiscoveredIssue(makeDiscoveredIssue(), makeRepoConfig(), WORKFLOW)

    expect(workItem.acceptanceCriteria).toEqual([
      'add smoke checks',
      'keep backward compatibility',
    ])
    expect(workItem.dependencies).toEqual([7])
  })
})

