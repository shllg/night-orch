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
    iterationSnapshots: [],
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

  it('no-review workflow + verify pass → publish', () => {
    const ctx = makeCtx({
      reviewResult: null,
      verifyResults: [{ command: 'test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
    expect(d.action).toBe('publish')
  })

  it('no-review workflow + verify fail → iterate', () => {
    const ctx = makeCtx({
      reviewResult: null,
      verifyResults: [{ command: 'test', exitCode: 1, stdout: '', stderr: 'FAIL', durationMs: 100, passed: false }],
    })
    const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
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

  it('subscription mode skips cost-over-budget block (reaches publish)', () => {
    const ctx = makeCtx({
      estimatedCostUsd: 500,
      reviewResult: {
        verdict: 'APPROVED',
        summary: 'Good',
        findings: [],
        definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
      },
      verifyResults: [{ command: 'test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const d = decide(ctx, loopConfig, securityConfig, { costModel: 'subscription' })
    expect(d.action).toBe('publish')
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

  describe('block reason discriminators', () => {
    it('cost limit block carries blockReason=cost_limit', () => {
      const ctx = makeCtx({
        estimatedCostUsd: 999,
        reviewResult: {
          verdict: 'APPROVED',
          summary: 'ok',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
      })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.blockReason).toBe('cost_limit')
    })

    it('agent pass limit block carries blockReason=agent_pass_limit', () => {
      const ctx = makeCtx({ totalAgentPasses: 10 })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.blockReason).toBe('agent_pass_limit')
    })

    it('CHANGES_REQUIRED at max iterations carries blockReason=iteration_limit', () => {
      const ctx = makeCtx({
        iteration: 4,
        reviewResult: {
          verdict: 'CHANGES_REQUIRED',
          summary: 'more work',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
        },
      })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.blockReason).toBe('iteration_limit')
    })

    it('BLOCKED verdict carries blockReason=reviewer_blocked', () => {
      const ctx = makeCtx({
        reviewResult: {
          verdict: 'BLOCKED',
          summary: 'Security concern',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
        },
      })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.blockReason).toBe('reviewer_blocked')
    })

    it('ambiguous review with blockOnAmbiguousReview carries blockReason=ambiguous_review', () => {
      const ctx = makeCtx({ reviewResult: null })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.blockReason).toBe('ambiguous_review')
    })

    it('APPROVED + requireVerificationPass but no verify commands → blockReason=verify_config', () => {
      const ctx = makeCtx({
        repoConfig: { ...makeCtx().repoConfig, verify: [] },
        verifyResults: [],
        reviewResult: {
          verdict: 'APPROVED',
          summary: 'ok',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
      })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.blockReason).toBe('verify_config')
    })
  })

  describe('no-review workflow (options.requireReview=false)', () => {
    const noReviewCtx = (overrides: Partial<RunContext> = {}): RunContext =>
      makeCtx({ reviewResult: null, ...overrides })

    it('blocks with verify_config when verify required but no commands configured', () => {
      const ctx = noReviewCtx({
        repoConfig: { ...makeCtx().repoConfig, verify: [] },
        verifyResults: [],
      })
      const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.blockReason).toBe('verify_config')
    })

    it('blocks with verify_config when verify commands configured but no results yet', () => {
      const ctx = noReviewCtx({ verifyResults: [] })
      const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.blockReason).toBe('verify_config')
    })

    it('iterates when verify failed but iteration is under the limit', () => {
      const ctx = noReviewCtx({
        iteration: 1,
        verifyResults: [{ command: 'pnpm test', exitCode: 1, stdout: '', stderr: 'fail', durationMs: 10, passed: false }],
      })
      const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
      expect(d.action).toBe('iterate')
    })

    it('blocks with iteration_limit when verify keeps failing past max iterations', () => {
      const ctx = noReviewCtx({
        iteration: 4,
        verifyResults: [{ command: 'pnpm test', exitCode: 1, stdout: '', stderr: 'fail', durationMs: 10, passed: false }],
      })
      const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.blockReason).toBe('iteration_limit')
    })

    it('publishes when verify passes', () => {
      const ctx = noReviewCtx({
        verifyResults: [{ command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 10, passed: true }],
      })
      const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
      expect(d.action).toBe('publish')
    })
  })

  describe('unknown verdict (type-safety escape)', () => {
    it('returns action=error with a descriptive reason', () => {
      const ctx = makeCtx({
        // Cast through unknown to exercise the default branch.
        reviewResult: {
          verdict: 'MAYBE' as unknown as 'APPROVED',
          summary: 'unsure',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
        },
      })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('error')
      if (d.action === 'error') expect(d.reason).toContain('Unknown review verdict')
    })
  })
})
