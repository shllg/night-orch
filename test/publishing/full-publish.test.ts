import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { publishPR } from '../../src/publishing/publisher.js'
import { transitionLabels } from '../../src/labels/manager.js'
import type { RunContext } from '../../src/loop/types.js'
import type { ForgeAdapter, ForgePR } from '../../src/forge/types.js'
import type { LabelConfig } from '../../src/labels/transitions.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

vi.mock('../../src/publishing/push.js', () => ({
  pushBranch: vi.fn(),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const labelConfig: LabelConfig = {
  ready: ['orch:ready'],
  running: 'orch:running',
  blocked: ['orch:blocked', 'orch:needs-human'],
  reviewReady: 'orch:review-ready',
  error: 'orch:error',
  retry: 'orch:retry',
}

function makePR(num: number): ForgePR {
  return {
    number: num,
    title: `PR #${num}`,
    body: 'body',
    state: 'open',
    headBranch: 'orch/1-fix',
    baseBranch: 'main',
    url: `https://github.com/org/repo/pull/${num}`,
  }
}

function makeMockForge(): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn().mockResolvedValue(makePR(10)),
    updatePR: vi.fn().mockResolvedValue(makePR(10)),
    findPRByBranch: vi.fn().mockResolvedValue(null),
    getPRDiff: vi.fn(),
  }
}

function makeCtx(): RunContext {
  return {
    runId: 'run-int-1',
    repo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: 'Fix bug', body: '', labels: ['orch:running'], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: 'https://github.com/org/repo/issues/1' },
    repoConfig: {
      repo: 'org/repo',
      forge: 'github',
      localPath: '/tmp/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      verify: [],
      selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
      agents: {},
    } as RunContext['repoConfig'],
    roles: { planner: 'claude', coder: 'claude', reviewer: 'claude' },
    triageResult: { level: 'standard', reason: '' },
    adjustedLimits: { maxReviewIterations: 4, maxTotalAgentPasses: 10, workerTimeoutSeconds: 1800 },
    branchName: 'orch/1-fix-bug',
    worktreePath: '/tmp/wt',
    plan: { objective: 'Fix', assumptions: [], filesToChange: [], steps: [], risks: [], testStrategy: '' },
    codeResult: { summary: 'Fixed', changedFiles: ['a.ts'], remainingUncertainty: null, blockers: null },
    verifyResults: [{ command: 'pnpm test', exitCode: 0, stdout: '', stderr: '', durationMs: 100, passed: true }],
    reviewResult: { verdict: 'APPROVED', summary: 'OK', findings: [], definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true } },
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 3,
    estimatedCostUsd: 0.5,
    currentPhase: 'publish',
    terminalStatus: 'publish',
    phaseHistory: [],
    dryRun: false,
  }
}

describe('Full publish integration', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-full-publish-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))

    db.prepare(
      "INSERT INTO issue_links (repo, issue_number, branch_name, branch_slug) VALUES ('org/repo', 1, 'orch/1-fix-bug', 'fix-bug')",
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full flow: PR created → labels updated → DB updated', async () => {
    const forge = makeMockForge()
    const ctx = makeCtx()

    // Publish PR
    const result = await publishPR(ctx, forge, db)

    expect(result.created).toBe(true)
    expect(result.prNumber).toBe(10)

    // Transition labels running → review_ready
    await transitionLabels(forge, ctx.repo, ctx.issueNumber, ctx.issue.labels, 'running', 'review_ready', labelConfig)

    expect(forge.addLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:review-ready'])
    expect(forge.removeLabels).toHaveBeenCalledWith('org/repo', 1, ['orch:running'])

    // DB should have PR number
    const row = db.prepare('SELECT pr_number FROM issue_links WHERE repo = ? AND issue_number = ?')
      .get('org/repo', 1) as { pr_number: number }
    expect(row.pr_number).toBe(10)
  })

  it('rerun: same issue → same PR updated (not duplicated)', async () => {
    const forge = makeMockForge({
      createPR: vi.fn().mockResolvedValue(makePR(10)),
      updatePR: vi.fn().mockResolvedValue(makePR(10)),
    })
    const ctx = makeCtx()

    // First publish → creates PR
    const result1 = await publishPR(ctx, forge, db)
    expect(result1.created).toBe(true)

    // DB now has pr_number = 10
    // Second publish → should update, not create
    const result2 = await publishPR(ctx, forge, db)
    expect(result2.created).toBe(false)

    // createPR called only once (first time), updatePR for second
    expect(forge.createPR).toHaveBeenCalledTimes(1)
    expect(forge.updatePR).toHaveBeenCalledTimes(1)
  })

  it('PR body includes issue reference and plan', async () => {
    const forge = makeMockForge()

    await publishPR(makeCtx(), forge, db)

    const call = vi.mocked(forge.createPR).mock.calls[0]!
    const body = call[1].body
    expect(body).toContain('Closes #1')
    expect(body).toContain('Fix')
    expect(body).not.toContain('Generated by')
  })
})
