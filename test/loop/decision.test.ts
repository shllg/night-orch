import { describe, it, expect } from 'vitest'
import { aggregateReviewVerdict, decide, decideEmptyDiffRetry } from '../../src/loop/decision.js'
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
  maxEmptyDiffRetries: 2,
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
      labels: { planning: 'no:planning' },
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
    reviewResults: {},
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
  it.each([
    [{}, null],
    [
      {
        review: {
          verdict: 'APPROVED',
          summary: 'Reviewer approved',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
        cr: {
          verdict: 'APPROVED',
          summary: 'CR approved',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
      },
      'APPROVED',
    ],
    [
      {
        review: {
          verdict: 'APPROVED',
          summary: 'Reviewer approved',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
        cr: {
          verdict: 'CHANGES_REQUIRED',
          summary: 'CR requested changes',
          findings: [{ severity: 'major', message: 'Missing tests', suggestedFix: null }],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: true, noBlockingFindings: false },
        },
      },
      'CHANGES_REQUIRED',
    ],
    [
      {
        review: {
          verdict: 'CHANGES_REQUIRED',
          summary: 'Reviewer requested changes',
          findings: [{ severity: 'minor', message: 'Naming', suggestedFix: null }],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: true, noBlockingFindings: false },
        },
        cr: {
          verdict: 'BLOCKED',
          summary: 'CR blocked',
          findings: [{ severity: 'critical', message: 'Unsafe change', suggestedFix: null }],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
        },
      },
      'BLOCKED',
    ],
  ] as const)('aggregates reviewer verdicts with worst verdict winning', (results, expected) => {
    expect(aggregateReviewVerdict(results)).toBe(expected)
  })

  it('APPROVED + verify pass → publish', () => {
    const ctx = makeCtx({
      reviewResults: {
        review: {
          verdict: 'APPROVED',
          summary: 'Good',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
      },
      verifyResults: [{ command: 'test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('publish')
  })

  it('APPROVED reviewer map + verify pass → publish', () => {
    const ctx = makeCtx({
      reviewResults: {
        review: {
          verdict: 'APPROVED',
          summary: 'Good',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
        cr: {
          verdict: 'APPROVED',
          summary: 'Also good',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
      },
      verifyResults: [{ command: 'test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    } as Partial<RunContext>)
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('publish')
  })

  it('planning label + coder output present → publish without review/verify', () => {
    const ctx = makeCtx({
      issue: { ...makeCtx().issue, labels: ['no:planning'] },
      codeResult: {
        summary: 'Wrote PRD',
        changedFiles: ['docs/prd/1-test.md'],
        remainingUncertainty: null,
        blockers: null,
      },
      verifyResults: [],
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('publish')
  })

  it('planning label + missing coder output → block', () => {
    const ctx = makeCtx({
      issue: { ...makeCtx().issue, labels: ['no:planning'] },
      codeResult: null,
      verifyResults: [],
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('APPROVED + verify fail → iterate', () => {
    const ctx = makeCtx({
      reviewResults: {
        review: {
          verdict: 'APPROVED',
          summary: 'Good',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: false, noBlockingFindings: true },
        },
      },
      verifyResults: [{ command: 'test', exitCode: 1, stdout: '', stderr: 'FAIL', durationMs: 100, passed: false }],
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('iterate')
  })

  it('CHANGES_REQUIRED + under limit → iterate with findings', () => {
    const ctx = makeCtx({
      iteration: 2,
      reviewResults: {
        review: {
          verdict: 'CHANGES_REQUIRED',
          summary: 'Fix it',
          findings: [{ severity: 'major', message: 'Missing error handling', suggestedFix: null }],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: true, noBlockingFindings: false },
        },
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
      reviewResults: {
        review: {
          verdict: 'CHANGES_REQUIRED',
          summary: 'Still broken',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
        },
      },
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('BLOCKED verdict → block', () => {
    const ctx = makeCtx({
      reviewResults: {
        review: {
          verdict: 'BLOCKED',
          summary: 'Needs human',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
        },
      },
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('parse failure + blockOnAmbiguousReview → block', () => {
    const ctx = makeCtx({ reviewResults: {} })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('parse failure + !blockOnAmbiguousReview → iterate', () => {
    const ctx = makeCtx({ reviewResults: {} })
    const d = decide(ctx, { ...loopConfig, blockOnAmbiguousReview: false }, securityConfig)
    expect(d.action).toBe('iterate')
  })

  it('no-review workflow + verify pass → publish', () => {
    const ctx = makeCtx({
      reviewResults: {},
      verifyResults: [{ command: 'test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
    expect(d.action).toBe('publish')
  })

  it('no-review workflow + verify fail → iterate', () => {
    const ctx = makeCtx({
      reviewResults: {},
      verifyResults: [{ command: 'test', exitCode: 1, stdout: '', stderr: 'FAIL', durationMs: 100, passed: false }],
    })
    const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
    expect(d.action).toBe('iterate')
  })

  it('cost over budget → block', () => {
    const ctx = makeCtx({
      estimatedCostUsd: 15,
      reviewResults: {
        review: {
          verdict: 'APPROVED',
          summary: 'Good',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
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
      reviewResults: {
        review: {
          verdict: 'APPROVED',
          summary: 'Good',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
      },
      verifyResults: [{ command: 'test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    })
    const d = decide(ctx, loopConfig, securityConfig, { costModel: 'subscription' })
    expect(d.action).toBe('publish')
  })

  it('max total passes → block', () => {
    const ctx = makeCtx({
      totalAgentPasses: 10,
      reviewResults: {
        review: {
          verdict: 'CHANGES_REQUIRED',
          summary: 'More work',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
        },
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
      reviewResults: {
        review: {
          verdict: 'APPROVED',
          summary: 'Good',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
      },
    })
    const d = decide(ctx, loopConfig, securityConfig)
    expect(d.action).toBe('block')
  })

  it('APPROVED with no verify commands + requireVerificationPass=false → publish', () => {
    const ctx = makeCtx({
      repoConfig: { ...makeCtx().repoConfig, verify: [] },
      verifyResults: [],
      reviewResults: {
        review: {
          verdict: 'APPROVED',
          summary: 'Good',
          findings: [],
          definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
        },
      },
    })
    const d = decide(ctx, { ...loopConfig, requireVerificationPass: false }, securityConfig)
    expect(d.action).toBe('publish')
  })

  describe('block reason discriminators', () => {
    it('cost limit block carries blockReason=cost_limit', () => {
      const ctx = makeCtx({
        estimatedCostUsd: 999,
        reviewResults: {
          review: {
            verdict: 'APPROVED',
            summary: 'ok',
            findings: [],
            definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
          },
        },
      })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.state.reason.type).toBe('costLimit')
    })

    it('agent pass limit block carries blockReason=agent_pass_limit', () => {
      const ctx = makeCtx({ totalAgentPasses: 10 })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.state.reason.type).toBe('agentPassLimit')
    })

    it('CHANGES_REQUIRED at max iterations carries blockReason=iteration_limit', () => {
      const ctx = makeCtx({
        iteration: 4,
        reviewResults: {
          review: {
            verdict: 'CHANGES_REQUIRED',
            summary: 'more work',
            findings: [],
            definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
          },
        },
      })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.state.reason.type).toBe('iterationLimit')
    })

    it('BLOCKED verdict carries blockReason=reviewer_blocked', () => {
      const ctx = makeCtx({
        reviewResults: {
          review: {
            verdict: 'BLOCKED',
            summary: 'Security concern',
            findings: [],
            definitionOfDoneCheck: { issueAddressed: false, testsPassing: false, noBlockingFindings: false },
          },
        },
      })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.state.reason.type).toBe('reviewerBlocked')
    })

    it('ambiguous review with blockOnAmbiguousReview carries blockReason=ambiguous_review', () => {
      const ctx = makeCtx({ reviewResults: {} })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.state.reason.type).toBe('ambiguousReview')
    })

    it('APPROVED + requireVerificationPass but no verify commands → blockReason=verify_config', () => {
      const ctx = makeCtx({
        repoConfig: { ...makeCtx().repoConfig, verify: [] },
        verifyResults: [],
        reviewResults: {
          review: {
            verdict: 'APPROVED',
            summary: 'ok',
            findings: [],
            definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
          },
        },
      })
      const d = decide(ctx, loopConfig, securityConfig)
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.state.reason.type).toBe('verifyConfig')
    })
  })

  describe('no-review workflow (options.requireReview=false)', () => {
    const noReviewCtx = (overrides: Partial<RunContext> = {}): RunContext =>
      makeCtx({ reviewResults: {}, ...overrides })

    it('blocks with verify_config when verify required but no commands configured', () => {
      const ctx = noReviewCtx({
        repoConfig: { ...makeCtx().repoConfig, verify: [] },
        verifyResults: [],
      })
      const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.state.reason.type).toBe('verifyConfig')
    })

    it('blocks with verify_config when verify commands configured but no results yet', () => {
      const ctx = noReviewCtx({ verifyResults: [] })
      const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
      expect(d.action).toBe('block')
      if (d.action === 'block') expect(d.state.reason.type).toBe('verifyConfig')
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
      if (d.action === 'block') expect(d.state.reason.type).toBe('iterationLimit')
    })

    it('publishes when verify passes', () => {
      const ctx = noReviewCtx({
        verifyResults: [{ command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 10, passed: true }],
      })
      const d = decide(ctx, loopConfig, securityConfig, { requireReview: false })
      expect(d.action).toBe('publish')
    })
  })

  describe('decideEmptyDiffRetry', () => {
    it('returns null when the diff is non-empty', () => {
      const ctx = makeCtx({ diff: 'diff --git a/x b/x\n+new line', emptyDiffRetries: 0 })
      expect(decideEmptyDiffRetry(ctx, loopConfig)).toBeNull()
    })

    it('returns null when the diff is a whitespace-only string', () => {
      // Treated as a real diff shape; decideEmptyDiffRetry leaves the
      // flow alone so reviewer still gets to weigh in.
      const ctx = makeCtx({ diff: 'something', emptyDiffRetries: 0 })
      expect(decideEmptyDiffRetry(ctx, loopConfig)).toBeNull()
    })

    it('returns iterate+jumpTo=coder on the first empty-diff attempt', () => {
      const ctx = makeCtx({ diff: null, emptyDiffRetries: 0 })
      const d = decideEmptyDiffRetry(ctx, loopConfig)
      expect(d).not.toBeNull()
      expect(d?.action).toBe('iterate')
      if (d?.action === 'iterate') {
        expect(d.jumpTo).toBe('coder')
        expect(d.findings).toEqual([])
        expect(d.reason).toMatch(/auto-retrying \(1\/3\)/)
      }
    })

    it('returns iterate+jumpTo=coder on subsequent attempts under the limit', () => {
      const ctx = makeCtx({ diff: null, emptyDiffRetries: 1 })
      const d = decideEmptyDiffRetry(ctx, loopConfig)
      expect(d?.action).toBe('iterate')
      if (d?.action === 'iterate') {
        expect(d.jumpTo).toBe('coder')
        expect(d.reason).toMatch(/auto-retrying \(2\/3\)/)
      }
    })

    it('returns block(emptyDiff) when retries exhausted', () => {
      // loopConfig.maxEmptyDiffRetries = 2 → the 3rd attempt (already at
      // count 2) should block rather than retry again.
      const ctx = makeCtx({ diff: null, emptyDiffRetries: 2 })
      const d = decideEmptyDiffRetry(ctx, loopConfig)
      expect(d?.action).toBe('block')
      if (d?.action === 'block') {
        expect(d.state.reason.type).toBe('emptyDiff')
        if (d.state.reason.type === 'emptyDiff') {
          expect(d.state.reason.retries).toBe(3)
        }
        expect(d.reason).toContain('Coder produced no file changes after 3 attempt(s)')
      }
    })

    it('respects a lower maxEmptyDiffRetries config', () => {
      const zeroRetries = { ...loopConfig, maxEmptyDiffRetries: 0 }
      const ctx = makeCtx({ diff: null, emptyDiffRetries: 0 })
      const d = decideEmptyDiffRetry(ctx, zeroRetries)
      // Zero retries allowed → first empty diff blocks immediately.
      expect(d?.action).toBe('block')
      if (d?.action === 'block') {
        expect(d.state.reason.type).toBe('emptyDiff')
      }
    })

    it('does not mutate the input context', () => {
      const ctx = makeCtx({ diff: null, emptyDiffRetries: 0 })
      const before = { ...ctx }
      decideEmptyDiffRetry(ctx, loopConfig)
      expect(ctx.emptyDiffRetries).toBe(before.emptyDiffRetries)
      expect(ctx.diff).toBe(before.diff)
    })
  })
})
