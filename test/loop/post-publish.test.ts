import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { executePostPublishSteps } from '../../src/loop/engine.js'
import { handlePostPublishReview } from '../../src/loop/post-publish.js'
import type { RunContext } from '../../src/loop/types.js'
import { initDatabase } from '../../src/state/db.js'
import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from '../../src/workers/types.js'
import { makeTestConfig } from '../helpers/factories.js'
import { createMetricsService } from '../../src/metrics/service.js'
import type { ForgeAdapter } from '../../src/forge/types.js'

const tokenUsage = { promptTokens: 10, completionTokens: 5 }

function makePostPublishConfig() {
  return makeTestConfig({
    workerProfiles: {
      codex: {
        type: 'codex',
        command: 'codex',
        args: ['-p'],
        workerTimeoutSeconds: 1800,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
      },
    },
  })
}

function makeReviewResult(
  summary: string,
  message: string,
  verdict: 'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED' = 'CHANGES_REQUIRED',
): WorkerTaskResult {
  return {
    rawOutput: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 25,
    parsed: {
      verdict,
      summary,
      findings: verdict === 'APPROVED' ? [] : [{ severity: 'major', message, suggestedFix: null }],
      definitionOfDoneCheck: {
        issueAddressed: verdict === 'APPROVED',
        testsPassing: true,
        noBlockingFindings: verdict === 'APPROVED',
      },
    },
    parseError: null,
    sessionId: null,
    tokenUsage,
  }
}

function makeParseFailureResult(): WorkerTaskResult {
  return {
    rawOutput: 'not json',
    exitCode: 0,
    timedOut: false,
    durationMs: 25,
    parsed: null,
    parseError: 'no valid reviewer output',
    sessionId: null,
    tokenUsage,
  }
}

function makeSingleResultAdapter(result: WorkerTaskResult): WorkerAdapter {
  return {
    runTask: vi.fn().mockResolvedValue(result),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: 'test' }),
  }
}

function makeThrowingAdapter(err: Error): WorkerAdapter {
  return {
    runTask: vi.fn().mockRejectedValue(err),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: 'test' }),
  }
}

function makeReviewerAdapter(calls: string[]): WorkerAdapter {
  const results = [
    makeReviewResult('CodeRabbit review', 'Fix null handling'),
    makeReviewResult('Snyk review', 'Upgrade vulnerable package'),
  ]
  let index = 0
  return {
    runTask: vi.fn().mockImplementation((input: WorkerTaskInput) => {
      calls.push(input.phase ?? '')
      const result = results[index] ?? results[results.length - 1]!
      index++
      return Promise.resolve(result)
    }),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: 'test' }),
  }
}

function makeCtx(): RunContext {
  const config = makeTestConfig()
  return {
    runId: 'run-post-publish-1',
    repo: 'org/repo',
    issueRepo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: 'issue-node', title: 'Issue', body: '', labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '' },
    repoConfig: config.repos[0]!,
    roles: { planner: 'codex', coder: 'codex', reviewer: 'codex' },
    triageResult: { level: 'standard', reason: 'test' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/1-fix',
    worktreePath: '/tmp/wt',
    plan: null,
    codeResult: null,
    diff: 'diff',
    verifyResults: [],
    reviewResults: {},
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 0,
    estimatedCostUsd: 0,
    currentPhase: 'completed',
    terminalStatus: 'publish',
    phaseHistory: [],
    dryRun: false,
    runMode: 'fresh',
    blockReason: null,
    prReviewFeedback: null,
    diffError: null,
    emptyDiffRetries: 0,
    sessionIds: {},
    stepOutputs: {},
    iterationSnapshots: [],
  }
}

function makeForge(): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
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
  }
}

describe('executePostPublishSteps', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-post-publish-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status) VALUES ('run-post-publish-1', 'org/repo', 1, 'review_ready')",
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs multiple post-publish reviewer steps in declared order and records handoffs for each', async () => {
    const calls: string[] = []
    const reviewer = makeReviewerAdapter(calls)
    const metrics = createMetricsService({ enabled: false, host: '127.0.0.1', port: 9090 })
    const incHandoffsSpy = vi.spyOn(metrics, 'incHandoffs')
    const config = makePostPublishConfig()

    await executePostPublishSteps({
      ctx: makeCtx(),
      db,
      prNumber: 42,
      prUrl: 'https://example.com/pr/42',
      config,
      adapters: { reviewer },
      metrics,
      workflow: {
        steps: [
          { type: 'worker', id: 'cr', role: 'reviewer', runWhen: 'post-publish', onChangesRequired: 'comment-only' },
          { type: 'worker', id: 'snyk', role: 'reviewer', runWhen: 'post-publish', onChangesRequired: 'comment-only' },
        ],
      },
    })

    expect(calls).toEqual(['cr', 'snyk'])
    const rows = db
      .prepare("SELECT step_id, kind FROM agent_handoffs WHERE run_id = ? ORDER BY id ASC")
      .all('run-post-publish-1') as Array<{ step_id: string; kind: string }>
    expect(rows).toEqual([
      { step_id: 'cr', kind: 'external-review-findings' },
      { step_id: 'snyk', kind: 'external-review-findings' },
    ])
    expect(incHandoffsSpy.mock.calls.map(([kind]) => kind)).toEqual([
      'external-review-findings',
      'external-review-findings',
    ])
  })

  it('returns an external review reaction when a post-publish reviewer requires changes with continue enabled', async () => {
    const reviewer = makeSingleResultAdapter(makeReviewResult('CodeRabbit review', 'Add a regression test'))
    const metrics = createMetricsService({ enabled: false, host: '127.0.0.1', port: 9090 })
    const incPostPublishStepSpy = vi.spyOn(metrics, 'incPostPublishStep')
    const forge = makeForge()
    const config = makePostPublishConfig()

    const result = await executePostPublishSteps({
      ctx: makeCtx(),
      db,
      prNumber: 42,
      prUrl: 'https://example.com/pr/42',
      config,
      adapters: { reviewer },
      metrics,
      workflow: {
        steps: [
          { type: 'worker', id: 'cr', role: 'reviewer', runWhen: 'post-publish', onChangesRequired: 'continue', commentOnIssue: false },
        ],
      },
      onPostPublishReview: (input) => handlePostPublishReview({
        ...input,
        forge,
        issueRepo: 'org/repo',
        issueNumber: 1,
        botUser: '',
        metrics,
      }),
    })

    expect(result.reactions).toHaveLength(1)
    expect(result.reactions[0]).toMatchObject({
      type: 'external_review',
      repo: 'org/repo',
      prNumber: 42,
      issueNumber: 1,
      stepId: 'cr',
      verdict: 'CHANGES_REQUIRED',
      summary: 'External review cr: CHANGES_REQUIRED',
    })
    expect(result.reactions[0]?.context).toContain('Add a regression test')
    expect(incPostPublishStepSpy).toHaveBeenCalledWith('cr', 'continue_queued')
  })

  it('records an error post-publish step result when the reviewer worker throws', async () => {
    const workerError = new Error('review worker failed')
    const reviewer = makeThrowingAdapter(workerError)
    const metrics = createMetricsService({ enabled: false, host: '127.0.0.1', port: 9090 })
    const incPostPublishStepSpy = vi.spyOn(metrics, 'incPostPublishStep')
    const config = makePostPublishConfig()

    await expect(executePostPublishSteps({
      ctx: makeCtx(),
      db,
      prNumber: 42,
      prUrl: 'https://example.com/pr/42',
      config,
      adapters: { reviewer },
      metrics,
      workflow: {
        steps: [
          { type: 'worker', id: 'cr', role: 'reviewer', runWhen: 'post-publish' },
        ],
      },
    })).rejects.toThrow('review worker failed')

    expect(incPostPublishStepSpy).toHaveBeenCalledWith('cr', 'error')
  })

  it('posts a prefixed issue comment by default for post-publish review findings', async () => {
    const reviewer = makeSingleResultAdapter(makeReviewResult('CodeRabbit review', 'Fix null handling'))
    const metrics = createMetricsService({ enabled: false, host: '127.0.0.1', port: 9090 })
    const forge = makeForge()
    const config = makePostPublishConfig()

    await executePostPublishSteps({
      ctx: makeCtx(),
      db,
      prNumber: 42,
      prUrl: 'https://example.com/pr/42',
      config,
      adapters: { reviewer },
      metrics,
      workflow: {
        steps: [
          { type: 'worker', id: 'cr', role: 'reviewer', runWhen: 'post-publish', onChangesRequired: 'comment-only', commentPrefix: '[CodeRabbit]' },
        ],
      },
      onPostPublishReview: (input) => handlePostPublishReview({
        ...input,
        forge,
        issueRepo: 'org/repo',
        issueNumber: 1,
        botUser: '',
        metrics,
      }),
    })

    expect(forge.commentOnIssue).toHaveBeenCalledWith(
      'org/repo',
      1,
      expect.stringContaining('<!-- night-orch:cr-run-post-publish-1 -->\n[CodeRabbit] External review: CHANGES_REQUIRED'),
    )
    const body = vi.mocked(forge.commentOnIssue).mock.calls[0]?.[2]
    expect(body).toContain('Fix null handling')
  })

  it('does not return a reaction when a post-publish reviewer approves', async () => {
    const reviewer = makeSingleResultAdapter(makeReviewResult('CodeRabbit approved', 'No findings', 'APPROVED'))
    const metrics = createMetricsService({ enabled: false, host: '127.0.0.1', port: 9090 })
    const incPostPublishStepSpy = vi.spyOn(metrics, 'incPostPublishStep')
    const forge = makeForge()
    const config = makePostPublishConfig()

    const result = await executePostPublishSteps({
      ctx: makeCtx(),
      db,
      prNumber: 42,
      prUrl: 'https://example.com/pr/42',
      config,
      adapters: { reviewer },
      metrics,
      workflow: {
        steps: [
          { type: 'worker', id: 'cr', role: 'reviewer', runWhen: 'post-publish', commentOnIssue: false },
        ],
      },
      onPostPublishReview: (input) => handlePostPublishReview({
        ...input,
        forge,
        issueRepo: 'org/repo',
        issueNumber: 1,
        botUser: '',
        metrics,
      }),
    })

    expect(result.reactions).toEqual([])
    expect(incPostPublishStepSpy).toHaveBeenCalledWith('cr', 'ok')
  })

  it('does not record a handoff or run post-publish review handling when reviewer output does not parse', async () => {
    const reviewer = makeSingleResultAdapter(makeParseFailureResult())
    const metrics = createMetricsService({ enabled: false, host: '127.0.0.1', port: 9090 })
    const onPostPublishReview = vi.fn()
    const config = makePostPublishConfig()

    const result = await executePostPublishSteps({
      ctx: makeCtx(),
      db,
      prNumber: 42,
      prUrl: 'https://example.com/pr/42',
      config,
      adapters: { reviewer },
      metrics,
      workflow: {
        steps: [
          { type: 'worker', id: 'cr', role: 'reviewer', runWhen: 'post-publish' },
        ],
      },
      onPostPublishReview,
    })

    const rows = db
      .prepare("SELECT step_id, kind FROM agent_handoffs WHERE run_id = ?")
      .all('run-post-publish-1')
    expect(rows).toEqual([])
    expect(result.reactions).toEqual([])
    expect(onPostPublishReview).not.toHaveBeenCalled()
  })
})
