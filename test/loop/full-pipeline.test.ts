import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { executeLoop, executePostPublishSteps, type LoopDependencies } from '../../src/loop/engine.js'
import { handlePostPublishReview } from '../../src/loop/post-publish.js'
import type { RunContext } from '../../src/loop/types.js'
import type { ResolvedWorkflow } from '../../src/loop/workflow.js'
import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from '../../src/workers/types.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import { initDatabase } from '../../src/state/db.js'
import { listHandoffs } from '../../src/state/handoffs.js'
import { makeTestConfig } from '../helpers/factories.js'

// Mock execa (verifier / commit / push paths)
vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../src/workers/env.js', () => ({
  buildWorkerEnv: vi.fn().mockReturnValue({ PATH: '/usr/bin' }),
  buildVerifierEnv: vi.fn().mockReturnValue({ PATH: '/usr/bin' }),
}))

vi.mock('../../src/git/repo.js', () => ({
  getDiffAgainstBranch: vi.fn().mockResolvedValue({
    diff: 'diff --git a/file.ts b/file.ts\n+added',
    error: null,
  }),
  getChangedFilesAgainstBranch: vi.fn().mockResolvedValue(['src/a.ts']),
}))

const RUN_ID = 'run-full-pipeline-1'

/**
 * Mirrors examples/configs/full-pipeline.yaml.
 *
 * plan -> code -> verify -> review -> cr-review -> decide -> (publish) -> post-cr
 */
const FULL_PIPELINE_WORKFLOW: ResolvedWorkflow = {
  steps: [
    { type: 'worker', id: 'plan', role: 'planner', prompt: 'examples/prompts/full-pipeline/planner-deep.md' },
    { type: 'worker', id: 'code', role: 'coder', continueFrom: 'plan', prompt: 'examples/prompts/full-pipeline/coder-tdd.md' },
    { type: 'verify', id: 'verify' },
    { type: 'worker', id: 'review', role: 'reviewer', reviewerKey: 'peer-review', prompt: 'examples/prompts/full-pipeline/reviewer.md' },
    { type: 'worker', id: 'cr-review', role: 'reviewer', reviewerKey: 'code-review', prompt: 'examples/prompts/full-pipeline/cr-skill.md' },
    { type: 'decide', id: 'decide', onIterate: 'code' },
    {
      type: 'worker',
      id: 'post-cr',
      role: 'reviewer',
      runWhen: 'post-publish',
      onChangesRequired: 'continue',
      commentOnIssue: true,
      commentPrefix: '[night-orch][post-cr]',
      prompt: 'examples/prompts/full-pipeline/cr-skill.md',
    },
  ],
}

const tokenUsage = { promptTokens: 100, completionTokens: 50, cacheReadTokens: 0 }

function makeWorkerResult(parsed: unknown): WorkerTaskResult {
  return {
    rawOutput: JSON.stringify(parsed),
    exitCode: 0,
    timedOut: false,
    durationMs: 25,
    parsed: parsed as WorkerTaskResult['parsed'],
    parseError: null,
    sessionId: null,
    tokenUsage,
  }
}

function makePlanResult(objective = 'Fix bug X') {
  return makeWorkerResult({
    objective,
    assumptions: ['tests exist'],
    filesToChange: ['src/a.ts'],
    steps: [{ order: 1, description: 'fix', files: ['src/a.ts'] }],
    risks: [],
    testStrategy: 'run tests',
  })
}

function makeCodeResult(summary = 'Fixed it') {
  return makeWorkerResult({
    summary,
    changedFiles: ['src/a.ts'],
    remainingUncertainty: null,
    blockers: null,
  })
}

function makeReviewResult(verdict: 'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED', message = 'looks ok') {
  return makeWorkerResult({
    verdict,
    summary: message,
    findings: verdict === 'APPROVED' ? [] : [{ severity: 'major', message, suggestedFix: null }],
    definitionOfDoneCheck: {
      issueAddressed: verdict === 'APPROVED',
      testsPassing: true,
      noBlockingFindings: verdict === 'APPROVED',
    },
  })
}

/**
 * Reviewer adapter that walks a script of verdicts in order. Both the
 * peer reviewer (`review` step) and the external reviewer (`cr-review`)
 * resolve to the same `reviewer` role in the adapter map; each loop
 * iteration calls them sequentially, so the script must list verdicts
 * in the order the steps execute.
 */
function makeScriptedReviewer(verdicts: Array<'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED'>) {
  const phaseCalls: string[] = []
  let index = 0
  const adapter: WorkerAdapter = {
    runTask: vi.fn().mockImplementation((input: WorkerTaskInput) => {
      phaseCalls.push(input.phase ?? '')
      const verdict = verdicts[index] ?? verdicts[verdicts.length - 1]!
      index += 1
      return Promise.resolve(makeReviewResult(verdict))
    }),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: 'test' }),
  }
  return { adapter, phaseCalls }
}

function makeBaseCtx(): RunContext {
  const config = makeTestConfig()
  const repoConfig = { ...config.repos[0]!, verify: ['pnpm test'] }
  return {
    runId: RUN_ID,
    repo: 'org/repo',
    issueRepo: 'org/repo',
    issueNumber: 42,
    issue: {
      number: 42,
      nodeId: 'issue-node-42',
      title: 'Integration: full pipeline',
      body: 'Test the full pipeline workflow',
      labels: ['bug'],
      assignees: [],
      state: 'open',
      createdAt: '',
      updatedAt: '',
      url: '',
    },
    repoConfig,
    roles: { planner: 'claude', coder: 'claude', reviewer: 'codex' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/42-full-pipeline',
    worktreePath: '/tmp/wt',
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
  }
}

function makeFullPipelineConfig() {
  return makeTestConfig({
    workerProfiles: {
      claude: {
        type: 'claude',
        command: 'claude',
        args: ['-p'],
        workerTimeoutSeconds: 1800,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
      },
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

describe('Full-pipeline workflow (examples/configs/full-pipeline.yaml)', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-full-pipeline-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    db.prepare(
      "INSERT INTO runs (id, repo, issue_number, status) VALUES (?, 'org/repo', 42, 'running')",
    ).run(RUN_ID)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('happy path: plan → code → verify → review(APPROVED) → cr-review(APPROVED) → publish', async () => {
    const planner: WorkerAdapter = {
      runTask: vi.fn().mockResolvedValue(makePlanResult()),
      checkAvailability: vi.fn(),
    }
    const coder: WorkerAdapter = {
      runTask: vi.fn().mockResolvedValue(makeCodeResult()),
      checkAvailability: vi.fn(),
    }
    const { adapter: reviewer, phaseCalls } = makeScriptedReviewer(['APPROVED', 'APPROVED'])

    const result = await executeLoop(makeBaseCtx(), {
      db,
      config: makeFullPipelineConfig(),
      adapters: { planner, coder, reviewer },
      workflow: FULL_PIPELINE_WORKFLOW,
    } satisfies LoopDependencies)

    expect(result.terminalStatus).toBe('publish')
    expect(planner.runTask).toHaveBeenCalledTimes(1)
    expect(coder.runTask).toHaveBeenCalledTimes(1)
    expect(reviewer.runTask).toHaveBeenCalledTimes(2)
    expect(phaseCalls).toEqual(['review', 'cr-review'])
    expect(result.reviewResults['peer-review']?.verdict).toBe('APPROVED')
    expect(result.reviewResults['code-review']?.verdict).toBe('APPROVED')
  })

  it('iterate path: cr-review CHANGES_REQUIRED jumps back to code, second pass APPROVED', async () => {
    const planner: WorkerAdapter = {
      runTask: vi.fn().mockResolvedValue(makePlanResult()),
      checkAvailability: vi.fn(),
    }
    const coder: WorkerAdapter = {
      runTask: vi.fn().mockResolvedValue(makeCodeResult()),
      checkAvailability: vi.fn(),
    }
    // Pass 1: review APPROVED, cr-review CHANGES_REQUIRED → iterate to code
    // Pass 2: review APPROVED, cr-review APPROVED → publish
    const { adapter: reviewer, phaseCalls } = makeScriptedReviewer([
      'APPROVED',
      'CHANGES_REQUIRED',
      'APPROVED',
      'APPROVED',
    ])

    const result = await executeLoop(makeBaseCtx(), {
      db,
      config: makeFullPipelineConfig(),
      adapters: { planner, coder, reviewer },
      workflow: FULL_PIPELINE_WORKFLOW,
    } satisfies LoopDependencies)

    expect(result.terminalStatus).toBe('publish')
    // Planner only runs once (skipped on iterate via continueFrom semantics)
    expect(planner.runTask).toHaveBeenCalledTimes(1)
    // Coder runs twice — once per pass
    expect(coder.runTask).toHaveBeenCalledTimes(2)
    // Reviewer called 4 times total (2 passes × 2 reviewer steps)
    expect(reviewer.runTask).toHaveBeenCalledTimes(4)
    expect(phaseCalls).toEqual(['review', 'cr-review', 'review', 'cr-review'])
    expect(result.iteration).toBeGreaterThanOrEqual(2)
  })

  it('persists agent_handoffs for every worker step', async () => {
    const planner: WorkerAdapter = {
      runTask: vi.fn().mockResolvedValue(makePlanResult()),
      checkAvailability: vi.fn(),
    }
    const coder: WorkerAdapter = {
      runTask: vi.fn().mockResolvedValue(makeCodeResult()),
      checkAvailability: vi.fn(),
    }
    const { adapter: reviewer } = makeScriptedReviewer(['APPROVED', 'APPROVED'])

    await executeLoop(makeBaseCtx(), {
      db,
      config: makeFullPipelineConfig(),
      adapters: { planner, coder, reviewer },
      workflow: FULL_PIPELINE_WORKFLOW,
    } satisfies LoopDependencies)

    const handoffs = listHandoffs(db, RUN_ID)
    const stepIds = handoffs.map(h => h.stepId)

    expect(stepIds).toContain('plan')
    expect(stepIds).toContain('code')
    expect(stepIds).toContain('review')
    expect(stepIds).toContain('cr-review')
    expect(handoffs.find(h => h.stepId === 'plan')?.kind).toBe('plan')
    expect(handoffs.find(h => h.stepId === 'code')?.kind).toBe('code-summary')
    expect(handoffs.find(h => h.stepId === 'review')?.kind).toBe('review-findings')
    expect(handoffs.find(h => h.stepId === 'cr-review')?.kind).toBe('review-findings')
  })

  it('post-publish: post-cr step queues continue on CHANGES_REQUIRED with onChangesRequired=continue', async () => {
    // Seed runs row in review_ready state — post-publish operates after publish
    db.prepare(`UPDATE runs SET status = 'review_ready' WHERE id = ?`).run(RUN_ID)

    const { adapter: reviewer } = makeScriptedReviewer(['CHANGES_REQUIRED'])
    const forge = makeForge()

    const result = await executePostPublishSteps({
      ctx: makeBaseCtx(),
      db,
      prNumber: 99,
      prUrl: 'https://example.com/pr/99',
      config: makeFullPipelineConfig(),
      adapters: { reviewer },
      workflow: FULL_PIPELINE_WORKFLOW,
      onPostPublishReview: async (input) => {
        const out = await handlePostPublishReview({
          ctx: input.ctx,
          step: input.step,
          review: input.review,
          forge,
          issueRepo: 'org/repo',
          issueNumber: 42,
          prNumber: input.prNumber,
          botUser: 'night-orch[bot]',
        })
        return { result: out.result, reaction: out.reaction ?? null }
      },
    })

    // onChangesRequired=continue should queue a follow-up reaction
    expect(result.reactions).toHaveLength(1)
    expect(result.reactions[0]?.type).toBe('external_review')
    // Comment on issue should have been posted (commentOnIssue=true)
    expect(forge.commentOnIssue).toHaveBeenCalledTimes(1)
  })

  it('post-publish: APPROVED verdict does NOT queue continue', async () => {
    db.prepare(`UPDATE runs SET status = 'review_ready' WHERE id = ?`).run(RUN_ID)

    const { adapter: reviewer } = makeScriptedReviewer(['APPROVED'])
    const forge = makeForge()

    const result = await executePostPublishSteps({
      ctx: makeBaseCtx(),
      db,
      prNumber: 99,
      prUrl: 'https://example.com/pr/99',
      config: makeFullPipelineConfig(),
      adapters: { reviewer },
      workflow: FULL_PIPELINE_WORKFLOW,
      onPostPublishReview: async (input) => {
        const out = await handlePostPublishReview({
          ctx: input.ctx,
          step: input.step,
          review: input.review,
          forge,
          issueRepo: 'org/repo',
          issueNumber: 42,
          prNumber: input.prNumber,
          botUser: 'night-orch[bot]',
        })
        return { result: out.result, reaction: out.reaction ?? null }
      },
    })

    expect(result.reactions).toHaveLength(0)
  })
})
