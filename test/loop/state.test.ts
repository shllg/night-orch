import { describe, it, expect } from 'vitest'
import {
  BLOCKED_REASON_TYPES,
  LEGACY_BLOCK_REASON_VALUES,
  RUN_STATE_KINDS,
  assertNever,
  blocked,
  blockReasonSummary,
  blockedReasonFromLegacy,
  blockedReasonToLegacy,
  describeBlockedReason,
  isBlockedReasonRecoverable,
  type BlockedReason,
  type BlockedReasonType,
  type RunState,
  type RunStateKind,
} from '../../src/loop/state.js'
import type { RunContext } from '../../src/loop/types.js'

describe('RunState discriminated union', () => {
  describe('LEGACY_BLOCK_REASON_VALUES', () => {
    it('contains every persisted legacy block reason', () => {
      expect(LEGACY_BLOCK_REASON_VALUES).toEqual([
        'cost_limit',
        'iteration_limit',
        'run_token_limit',
        'issue_token_limit',
        'daily_token_limit',
        'run_wall_clock_limit',
        'stuck_loop',
        'agent_pass_limit',
        'reviewer_blocked',
        'ambiguous_review',
        'verify_config',
        'merge_conflict',
        'auth_failure',
        'empty_diff',
      ])
    })
  })

  describe('RUN_STATE_KINDS', () => {
    it('contains all top-level kinds the union defines', () => {
      // Build a representative instance of every kind so the test fails
      // at compile time (satisfies RunState) if a new kind is added
      // without updating the list.
      const samples: RunState[] = [
        { kind: 'running', phase: 'code' },
        { kind: 'publishing', prUrl: 'https://example/pr/1' },
        { kind: 'published', prUrl: 'https://example/pr/1' },
        blocked({ type: 'costLimit', limit: 'per-run', actualUsd: 1, limitUsd: 0.5 }),
        { kind: 'error', message: 'boom', cause: 'transient' },
      ]
      const kinds = new Set(samples.map((s) => s.kind))
      for (const k of RUN_STATE_KINDS) {
        expect(kinds.has(k)).toBe(true)
      }
      expect(kinds.size).toBe(RUN_STATE_KINDS.length)
    })
  })

  describe('BLOCKED_REASON_TYPES', () => {
    it('covers every BlockedReason variant in the union', () => {
      // One concrete BlockedReason of every type, typed as the union so
      // TypeScript refuses to compile if a reason type goes missing.
      const samples: BlockedReason[] = [
        { type: 'costLimit', limit: 'per-run', actualUsd: 5, limitUsd: 10 },
        { type: 'iterationLimit', iterations: 4, max: 4 },
        { type: 'agentPassLimit', passes: 10, max: 10 },
        { type: 'reviewerBlocked', summary: 'nope' },
        { type: 'ambiguousReview', excerpt: 'mangled' },
        { type: 'verifyConfig', detail: 'no verify commands' },
        { type: 'mergeConflict', files: ['a.ts'], summary: 'conflict' },
        { type: 'authFailure', adapter: 'claude' },
        { type: 'emptyDiff', retries: 2 },
        { type: 'workerTimeout', adapter: 'claude', step: 'coder', timeoutMs: 60000 },
        { type: 'tokenCaptureFailed', adapter: 'codex', step: 'planner' },
      ]
      const types = new Set(samples.map((s) => s.type))
      for (const t of BLOCKED_REASON_TYPES) {
        expect(types.has(t)).toBe(true)
      }
      expect(types.size).toBe(BLOCKED_REASON_TYPES.length)
    })
  })

  describe('describeBlockedReason', () => {
    // Table-driven exhaustive coverage — one row per reason type.
    const cases: Array<{ reason: BlockedReason; matches: RegExp }> = [
      {
        reason: { type: 'costLimit', limit: 'per-run', actualUsd: 12.5, limitUsd: 10 },
        matches: /Cost limit \(per-run\): \$12\.50 of \$10\.00/,
      },
      {
        reason: { type: 'iterationLimit', iterations: 4, max: 4 },
        matches: /iteration limit reached: 4\/4/,
      },
      {
        reason: { type: 'agentPassLimit', passes: 10, max: 10 },
        matches: /agent passes reached: 10\/10/,
      },
      {
        reason: { type: 'reviewerBlocked', summary: 'no, this is wrong' },
        matches: /Reviewer blocked: no, this is wrong/,
      },
      {
        reason: { type: 'ambiguousReview', excerpt: 'malformed output' },
        matches: /not parseable: malformed output/,
      },
      {
        reason: { type: 'verifyConfig', detail: 'no verify commands configured' },
        matches: /Verify configuration error: no verify commands configured/,
      },
      {
        reason: { type: 'mergeConflict', files: ['a.ts', 'b.ts'], summary: 'rebase conflict' },
        matches: /Merge conflict in 2 file\(s\): rebase conflict/,
      },
      {
        reason: { type: 'authFailure', adapter: 'claude' },
        matches: /authentication failed: claude/,
      },
      {
        reason: { type: 'emptyDiff', retries: 3 },
        matches: /empty diff \(3 retries\)/,
      },
      {
        reason: { type: 'workerTimeout', adapter: 'codex', step: 'coder', timeoutMs: 30000 },
        matches: /codex timed out during coder after 30000ms/,
      },
      {
        reason: { type: 'tokenCaptureFailed', adapter: 'claude', step: 'reviewer' },
        matches: /claude produced output without parseable token usage \(reviewer\)/,
      },
    ]

    it.each(cases)('describes %s', ({ reason, matches }) => {
      expect(describeBlockedReason(reason)).toMatch(matches)
    })

    it('covers every BlockedReason type', () => {
      const covered = new Set(cases.map((c) => c.reason.type))
      expect(covered.size).toBe(BLOCKED_REASON_TYPES.length)
    })
  })

  describe('blockReasonSummary', () => {
    const cases: Array<{ reason: BlockedReason; matches: RegExp }> = [
      { reason: { type: 'costLimit', limit: 'per-run', actualUsd: 12, limitUsd: 10 }, matches: /Cost limit exceeded/ },
      { reason: { type: 'iterationLimit', iterations: 4, max: 4 }, matches: /Maximum review iterations reached/ },
      { reason: { type: 'agentPassLimit', passes: 10, max: 10 }, matches: /Maximum total agent passes reached/ },
      { reason: { type: 'reviewerBlocked', summary: 'no' }, matches: /Reviewer marked this run as blocked/ },
      { reason: { type: 'ambiguousReview', excerpt: 'mangled' }, matches: /Review output was not parseable/ },
      { reason: { type: 'verifyConfig', detail: 'missing' }, matches: /Verification is required/ },
      { reason: { type: 'mergeConflict', files: ['a.ts'], summary: 'conflict' }, matches: /conflict encountered/ },
      { reason: { type: 'authFailure', adapter: 'codex' }, matches: /codex/ },
      { reason: { type: 'emptyDiff', retries: 2 }, matches: /no file changes/ },
      { reason: { type: 'workerTimeout', adapter: 'claude', step: 'coder', timeoutMs: 30000 }, matches: /timed out during coder/ },
      { reason: { type: 'tokenCaptureFailed', adapter: 'claude', step: 'reviewer' }, matches: /without parseable token usage/ },
    ]

    it.each(cases)('summarizes %s', ({ reason, matches }) => {
      expect(blockReasonSummary(reason, makeSummaryCtx())).toMatch(matches)
    })

    it('covers every BlockedReason type', () => {
      const covered = new Set(cases.map((c) => c.reason.type))
      expect(covered.size).toBe(BLOCKED_REASON_TYPES.length)
    })
  })

  describe('isBlockedReasonRecoverable', () => {
    const recoverable: BlockedReasonType[] = [
      'costLimit',
      'iterationLimit',
      'agentPassLimit',
      'ambiguousReview',
      'emptyDiff',
      'workerTimeout',
    ]
    const notRecoverable: BlockedReasonType[] = [
      'reviewerBlocked',
      'verifyConfig',
      'mergeConflict',
      'authFailure',
      'tokenCaptureFailed',
    ]

    it('marks recoverable reasons correctly', () => {
      for (const t of recoverable) {
        const reason = stubReason(t)
        expect(isBlockedReasonRecoverable(reason)).toBe(true)
      }
    })

    it('marks non-recoverable reasons correctly', () => {
      for (const t of notRecoverable) {
        const reason = stubReason(t)
        expect(isBlockedReasonRecoverable(reason)).toBe(false)
      }
    })

    it('partitions every BlockedReason type into exactly one bucket', () => {
      const union = new Set<BlockedReasonType>([...recoverable, ...notRecoverable])
      expect(union.size).toBe(BLOCKED_REASON_TYPES.length)
      expect(recoverable.length + notRecoverable.length).toBe(BLOCKED_REASON_TYPES.length)
    })
  })

  describe('blocked() constructor', () => {
    it('defaults the message from describeBlockedReason', () => {
      const state = blocked({ type: 'iterationLimit', iterations: 4, max: 4 })
      expect(state.kind).toBe('blocked')
      expect(state.message).toMatch(/iteration limit reached: 4\/4/)
      expect(state.recoverable).toBe(true)
      expect(state.reason.type).toBe('iterationLimit')
    })

    it('respects explicit message and recoverable overrides', () => {
      const state = blocked(
        { type: 'costLimit', limit: 'daily', actualUsd: 50, limitUsd: 25 },
        { message: 'daily cap exceeded', recoverable: false },
      )
      expect(state.message).toBe('daily cap exceeded')
      expect(state.recoverable).toBe(false)
    })
  })

  describe('legacy bridge round-trip', () => {
    const legacyTypes = [
      'cost_limit',
      'iteration_limit',
      'agent_pass_limit',
      'reviewer_blocked',
      'ambiguous_review',
      'verify_config',
      'merge_conflict',
      'auth_failure',
      'empty_diff',
    ] as const

    it('round-trips every legacy BlockReason through fromLegacy/toLegacy', () => {
      for (const legacy of legacyTypes) {
        const typed = blockedReasonFromLegacy(legacy)
        expect(blockedReasonToLegacy(typed)).toBe(legacy)
      }
    })

    it('fromLegacy fills context fields when provided', () => {
      const cost = blockedReasonFromLegacy('cost_limit', {
        actualCostUsd: 12.5,
        costLimitUsd: 10,
        costLimitScope: 'daily',
      })
      expect(cost).toEqual({
        type: 'costLimit',
        limit: 'daily',
        actualUsd: 12.5,
        limitUsd: 10,
      })

      const iter = blockedReasonFromLegacy('iteration_limit', {
        iterations: 4,
        maxIterations: 4,
      })
      expect(iter).toEqual({ type: 'iterationLimit', iterations: 4, max: 4 })
    })

    it('fromLegacy falls back to zero/empty when context is missing', () => {
      const cost = blockedReasonFromLegacy('cost_limit')
      expect(cost).toEqual({ type: 'costLimit', limit: 'per-run', actualUsd: 0, limitUsd: 0 })
    })

    it('R1-new reasons bridge to auth_failure on toLegacy (no pre-R1 counterpart)', () => {
      expect(
        blockedReasonToLegacy({
          type: 'workerTimeout',
          adapter: 'claude',
          step: 'coder',
          timeoutMs: 1000,
        }),
      ).toBe('auth_failure')
      expect(
        blockedReasonToLegacy({
          type: 'tokenCaptureFailed',
          adapter: 'claude',
          step: 'planner',
        }),
      ).toBe('auth_failure')
    })
  })

  describe('assertNever', () => {
    it('throws with a helpful message including the context label', () => {
      expect(() => assertNever('nope' as never, 'testing')).toThrow(/Non-exhaustive RunState variant in testing/)
    })

    it('throws without context when no label given', () => {
      expect(() => assertNever('nope' as never)).toThrow(/Non-exhaustive RunState variant:/)
    })
  })

  describe('switch exhaustiveness', () => {
    // These small wrapper functions exist purely to pin the exhaustiveness
    // check at compile time: if a new `kind` or `BlockedReason` type is
    // added without updating the switch, TypeScript errors on
    // `assertNever` because `state` is no longer narrowed to `never`.
    function runStateKindLabel(state: RunState): RunStateKind {
      switch (state.kind) {
        case 'running':
          return 'running'
        case 'publishing':
          return 'publishing'
        case 'published':
          return 'published'
        case 'blocked':
          return 'blocked'
        case 'error':
          return 'error'
        default:
          return assertNever(state, 'runStateKindLabel')
      }
    }

    function blockedReasonTypeLabel(reason: BlockedReason): BlockedReasonType {
      switch (reason.type) {
        case 'costLimit':
          return 'costLimit'
        case 'iterationLimit':
          return 'iterationLimit'
        case 'agentPassLimit':
          return 'agentPassLimit'
        case 'reviewerBlocked':
          return 'reviewerBlocked'
        case 'ambiguousReview':
          return 'ambiguousReview'
        case 'verifyConfig':
          return 'verifyConfig'
        case 'mergeConflict':
          return 'mergeConflict'
        case 'authFailure':
          return 'authFailure'
        case 'emptyDiff':
          return 'emptyDiff'
        case 'workerTimeout':
          return 'workerTimeout'
        case 'tokenCaptureFailed':
          return 'tokenCaptureFailed'
        default:
          return assertNever(reason, 'blockedReasonTypeLabel')
      }
    }

    it('narrows every kind', () => {
      expect(runStateKindLabel({ kind: 'running', phase: 'plan' })).toBe('running')
      expect(runStateKindLabel({ kind: 'publishing' })).toBe('publishing')
      expect(runStateKindLabel({ kind: 'published', prUrl: 'x' })).toBe('published')
      expect(runStateKindLabel(blocked({ type: 'emptyDiff', retries: 1 }))).toBe('blocked')
      expect(runStateKindLabel({ kind: 'error', message: 'x', cause: 'fatal' })).toBe('error')
    })

    it('narrows every blocked reason', () => {
      for (const t of BLOCKED_REASON_TYPES) {
        expect(blockedReasonTypeLabel(stubReason(t))).toBe(t)
      }
    })
  })
})

function stubReason(type: BlockedReasonType): BlockedReason {
  switch (type) {
    case 'costLimit':
      return { type: 'costLimit', limit: 'per-run', actualUsd: 0, limitUsd: 0 }
    case 'iterationLimit':
      return { type: 'iterationLimit', iterations: 0, max: 0 }
    case 'agentPassLimit':
      return { type: 'agentPassLimit', passes: 0, max: 0 }
    case 'reviewerBlocked':
      return { type: 'reviewerBlocked', summary: '' }
    case 'ambiguousReview':
      return { type: 'ambiguousReview', excerpt: '' }
    case 'verifyConfig':
      return { type: 'verifyConfig', detail: '' }
    case 'mergeConflict':
      return { type: 'mergeConflict', files: [], summary: '' }
    case 'authFailure':
      return { type: 'authFailure', adapter: 'claude' }
    case 'emptyDiff':
      return { type: 'emptyDiff', retries: 0 }
    case 'workerTimeout':
      return { type: 'workerTimeout', adapter: 'claude', step: 'coder', timeoutMs: 0 }
    case 'tokenCaptureFailed':
      return { type: 'tokenCaptureFailed', adapter: 'claude', step: 'coder' }
  }
}

function makeSummaryCtx(): RunContext {
  return {
    runId: 'run-1',
    repo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: 'Issue', body: '', labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: {} as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'codex', reviewer: 'codex' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/1-issue',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: null,
    verifyResults: [],
    reviewResult: null,
    reviewFindings: [],
    iteration: 4,
    totalAgentPasses: 10,
    estimatedCostUsd: 12.3456,
    currentPhase: 'review',
    terminalStatus: 'running',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh',
    blockReason: null,
    prReviewFeedback: null,
    diffError: null,
    emptyDiffRetries: 2,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
  }
}
