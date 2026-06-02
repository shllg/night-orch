import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { executePostPublishSteps } from '../../src/loop/engine.js'
import type { RunContext } from '../../src/loop/types.js'
import { initDatabase } from '../../src/state/db.js'
import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from '../../src/workers/types.js'
import { makeTestConfig } from '../helpers/factories.js'
import { createMetricsService } from '../../src/metrics/service.js'

const tokenUsage = { promptTokens: 10, completionTokens: 5 }

function makeReviewResult(summary: string, message: string): WorkerTaskResult {
  return {
    rawOutput: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 25,
    parsed: {
      verdict: 'CHANGES_REQUIRED',
      summary,
      findings: [{ severity: 'major', message, suggestedFix: null }],
      definitionOfDoneCheck: {
        issueAddressed: false,
        testsPassing: true,
        noBlockingFindings: false,
      },
    },
    parseError: null,
    sessionId: null,
    tokenUsage,
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
    reviewResult: null,
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
    const config = makeTestConfig({
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
})
