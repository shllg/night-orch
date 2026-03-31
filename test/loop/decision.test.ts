import { describe, it, expect } from 'vitest'
import { decide } from '../../src/loop/decision.js'
import type { RunContext } from '../../src/loop/types.js'
import type { Config } from '../../src/config/schema.js'

const loopConfig: Config['loop'] = {
  maxReviewIterations: 4,
  maxTotalAgentPasses: 10,
  stopOnPlannerFailure: true,
  requireVerificationPass: true,
  reviewApprovalKeyword: 'APPROVED',
  reviewNeedsChangesKeyword: 'CHANGES_REQUIRED',
  blockOnAmbiguousReview: true,
}

const securityConfig: Config['security'] = {
  maxChangedFiles: 50,
  maxChangedLines: 5000,
  maxDailyCostUsd: 50,
  maxCostPerRunUsd: 10,
}

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-test',
    repo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: '', body: '', labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: {
      verify: ['pnpm test'],
      labels: { planning: 'orch:planning' },
      planning: { prdDirectory: 'docs/prd' },
    } as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/1-test',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 3,
    estimatedCostUsd: 0,
    currentPhase: 'decision',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh' as const,
    blockReason: null,
    prReviewFeedback: null,
    sessionIds: {},
    stepOutputs: {},
    ...overrides,
  }
}

describe('decide', () => {
  it('APPROVED + verify pass → publish', () => {
    const ctx = makeCtx({
      reviewResult: {
        verdict: 'APPROVED',
        summary: 'Good',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
      },
      verifyResults: [{ command: 'test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('publish')
  })

  it('planning label + coder output present → publish without review/verify', () => {
    const ctx = makeCtx({
      issue: { ...makeCtx().issue, labels: ['orch:planning'] },
      codeResult: {
        summary: 'Wrote PRD',
        changedFiles: ['docs/prd/1-test.md'],
        remainingUncertainty: null,
        blockers: null,
      },
      reviewResult: null,
      verifyResults: [],
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('publish')
  })

  it('planning label + missing coder output → block', () => {
    const ctx = makeCtx({
      issue: { ...makeCtx().issue, labels: ['orch:planning'] },
      codeResult: null,
      reviewResult: null,
      verifyResults: [],
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('APPROVED + verify fail → iterate', () => {
    const ctx = makeCtx({
      reviewResult: {
        verdict: 'APPROVED',
        summary: 'Good',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: false, noBlockingFindings: true },
      },
      verifyResults: [{ command: 'test', exitCode: 1, stdout: '', stderr: 'FAIL', durationMs: 100, passed: false }],
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('iterate')
  })

  it('CHANGES_REQUIRED + under limit → iterate with findings', () => {
    const ctx = makeCtx({
      iteration: 2,
      reviewResult: {
        verdict: 'CHANGES_REQUIRED',
        summary: 'Fix it',
        findings: [{ severity: 'major', message: 'Missing error handling', suggestedFix: null }],
        definitionOfDoneCheck: { issueAddressed: false, testsPassing: true, noBlockingFindings: false },
      },
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('iterate')
    if (d.action === 'iterate') {
      expect(d.findings).toHaveLength(1)
    }
  })

  it('CHANGES_REQUIRED + at max iterations → block', () => {
    const ctx = makeCtx({
      iteration: 4,
      reviewResult: {
        verdict: 'CHANGES_REQUIRED',
        summary: 'Still broken',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
      },
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('BLOCKED verdict → block', () => {
    const ctx = makeCtx({
      reviewResult: {
        verdict: 'BLOCKED',
        summary: 'Needs human',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
      },
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('parse failure + blockOnAmbiguousReview → block', () => {
    const ctx = makeCtx({ reviewResult: null })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('parse failure + !blockOnAmbiguousReview → iterate', () => {
    const ctx = makeCtx({ reviewResult: null })
    const d = decide(ctx, { ...loopConfig, blockOnAmbiguousReview: false }, securityConfig)
    expect(d.action).toBe('iterate')
  })

  it('cost over budget → block', () => {
    const ctx = makeCtx({
      estimatedCostUsd: 15,
      reviewResult: {
        verdict: 'APPROVED',
        summary: 'Good',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
      },
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
    if (d.action === 'block') {
      expect(d.reason).toContain('cost')
    }
  })

  it('max total passes → block', () => {
    const ctx = makeCtx({
      totalAgentPasses: 10,
      reviewResult: {
        verdict: 'CHANGES_REQUIRED',
        summary: 'More work',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
      },
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
    if (d.action === 'block') {
      expect(d.reason).toContain('total agent passes')
    }
  })

  it('APPROVED with empty verify results + requireVerificationPass → block', () => {
    const ctx = makeCtx({
      verifyResults: [],
      reviewResult: {
        verdict: 'APPROVED',
        summary: 'Good',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
      },
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('APPROVED with no verify commands + requireVerificationPass=false → publish', () => {
    const ctx = makeCtx({
      repoConfig: { ...makeCtx().repoConfig, verify: [] },
      verifyResults: [],
      reviewResult: {
        verdict: 'APPROVED',
        summary: 'Good',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
      },
    })
    const d = decide(ctx, { ...loopConfig, requireVerificationPass: false }, securityConfig)
    expect(d.action).toBe('publish')
  })
})
