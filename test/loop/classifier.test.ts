import { describe, it, expect } from 'vitest'
import { classifyPhaseFailure } from '../../src/loop/classifier.js'
import type { RunContext, PhaseRecord, LoopDecision, BlockReason } from '../../src/loop/types.js'

function baseCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'r1',
    repo: 'org/repo',
    issueRepo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: '', body: '', labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: {} as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: '',
    worktreePath: '',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResults: {},
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'plan',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh',
    blockReason: null,
    prReviewFeedback: null,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
    diffError: null,
    emptyDiffRetries: 0,
    ...overrides,
  } as RunContext
}

function record(phase: string, result: PhaseRecord['result'], artifacts: Record<string, unknown> = {}): PhaseRecord {
  return { phase, startedAt: '', completedAt: '', result, artifacts }
}

function blockDecision(reason: BlockReason): LoopDecision {
  return {
    action: 'block',
    reason: 'mock',
    state: { kind: 'blocked', message: reason, recoverable: false, reason: reason as never },
  } as LoopDecision
}

describe('classifyPhaseFailure', () => {
  describe('BlockReason → classifier mapping', () => {
    const cases: Array<[BlockReason, string]> = [
      ['cost_limit', 'cost_blow'],
      ['run_token_limit', 'cost_blow'],
      ['issue_token_limit', 'cost_blow'],
      ['daily_token_limit', 'cost_blow'],
      ['iteration_limit', 'iteration_exhaust'],
      ['agent_pass_limit', 'iteration_exhaust'],
      ['run_wall_clock_limit', 'time_exhaust'],
      ['stuck_loop', 'stuck_loop'],
      ['reviewer_blocked', 'review_loop'],
      ['ambiguous_review', 'prompt_ambiguity'],
      ['verify_config', 'verify_regression'],
      ['merge_conflict', 'git_conflict'],
      ['auth_failure', 'auth_drift'],
      ['empty_diff', 'empty_diff'],
    ]
    for (const [reason, expected] of cases) {
      it(`maps BlockReason '${reason}' → classifier '${expected}'`, () => {
        const ctx = baseCtx({ blockReason: reason })
        const r = classifyPhaseFailure(ctx, record('plan', 'failure'), blockDecision(reason))
        expect(r?.classifier).toBe(expected)
        expect(r?.severity).toBe('error')
      })
    }
  })

  describe('structural plan checks (success)', () => {
    it('flags vague_plan when objective < 24 chars', () => {
      const ctx = baseCtx({
        plan: { objective: 'fix it', assumptions: [], filesToChange: [], steps: [], risks: [], testStrategy: 'run tests' },
      } as Partial<RunContext>)
      const r = classifyPhaseFailure(ctx, record('plan', 'success'))
      expect(r?.classifier).toBe('vague_plan')
      expect(r?.severity).toBe('warn')
    })

    it('flags vague_plan when testStrategy is empty', () => {
      const ctx = baseCtx({
        plan: {
          objective: 'Some long enough objective string here',
          assumptions: [],
          filesToChange: [],
          steps: [],
          risks: [],
          testStrategy: '',
        },
      } as Partial<RunContext>)
      const r = classifyPhaseFailure(ctx, record('plan', 'success'))
      expect(r?.classifier).toBe('vague_plan')
    })

    it('returns null for a well-formed plan on success', () => {
      const ctx = baseCtx({
        plan: {
          objective: 'Refactor the worker adapter contract to support skill bridge',
          assumptions: [],
          filesToChange: [],
          steps: [],
          risks: [],
          testStrategy: 'pnpm test + manual run',
        },
      } as Partial<RunContext>)
      const r = classifyPhaseFailure(ctx, record('plan', 'success'))
      expect(r).toBeNull()
    })

    it('returns null for non-plan phase success', () => {
      expect(classifyPhaseFailure(baseCtx(), record('code', 'success'))).toBeNull()
    })
  })

  describe('failure mode inference from artifacts.errorMessage', () => {
    const ctx = baseCtx()
    const errorCases: Array<[string, string, string]> = [
      ['rate_limit_provider on 429', 'HTTP 429 too many requests', 'rate_limit_provider'],
      ['rate_limit_provider on rate limit text', 'rate limit reached', 'rate_limit_provider'],
      ['upstream_outage on 5xx', 'HTTP 503 upstream', 'upstream_outage'],
      ['provider_refusal on content filter', 'content filter triggered', 'provider_refusal'],
      ['provider_refusal on refused', 'request refused by safety system', 'provider_refusal'],
      ['context_exhaustion on token limit', 'context length exceeded', 'context_exhaustion'],
      ['tool_hallucination on parse error', 'failed to parse tool call output', 'tool_hallucination'],
    ]
    for (const [label, errMsg, expected] of errorCases) {
      it(label, () => {
        const r = classifyPhaseFailure(ctx, record('code', 'failure', { errorMessage: errMsg }))
        expect(r?.classifier).toBe(expected)
      })
    }
  })

  describe('verify-phase failures', () => {
    it('dependency_error on npm install failure in verify phase', () => {
      const r = classifyPhaseFailure(
        baseCtx(),
        record('verify', 'failure', { errorMessage: 'npm install failed ENOENT' }),
      )
      expect(r?.classifier).toBe('dependency_error')
    })

    it('falls back to verify_regression for unrecognized verify failure', () => {
      const r = classifyPhaseFailure(
        baseCtx(),
        record('verify', 'failure', { errorMessage: 'tests broken' }),
      )
      expect(r?.classifier).toBe('verify_regression')
    })
  })

  it('returns null for non-failure, non-plan-anomaly phase', () => {
    expect(classifyPhaseFailure(baseCtx(), record('code', 'failure', {}))).toBeNull()
  })
})
