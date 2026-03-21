import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { publishPR } from '../../src/publishing/publisher.js'
import type { RunContext } from '../../src/loop/types.js'
import type { ForgeAdapter, ForgePR } from '../../src/forge/types.js'
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

import { pushBranch } from '../../src/publishing/push.js'

const mockPushBranch = vi.mocked(pushBranch)

function makePR(overrides: Partial<ForgePR> = {}): ForgePR {
  return {
    number: 10,
    title: 'PR',
    body: 'body',
    state: 'open',
    headBranch: 'orch/1-fix',
    baseBranch: 'main',
    url: 'https://github.com/org/repo/pull/10',
    ...overrides,
  }
}

function makeMockForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    commentOnIssue: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn().mockResolvedValue(makePR()),
    updatePR: vi.fn().mockResolvedValue(makePR()),
    findPRByBranch: vi.fn().mockResolvedValue(null),
    getPRDiff: vi.fn(),
    ...overrides,
  }
}

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-pub-1',
    repo: 'org/repo',
    issueNumber: 1,
    issue: { number: 1, nodeId: '', title: 'Fix bug', body: '', labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: 'https://github.com/org/repo/issues/1' },
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
    plan: { objective: 'Fix it', assumptions: [], filesToChange: [], steps: [], risks: [], testStrategy: '' },
    codeResult: { summary: 'Fixed', changedFiles: ['a.ts'], remainingUncertainty: null, blockers: null },
    verifyResults: [],
    reviewResult: { verdict: 'APPROVED', summary: 'OK', findings: [], definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true } },
    reviewFindings: [],
    iteration: 1,
    totalAgentPasses: 3,
    estimatedCostUsd: 0,
    currentPhase: 'publish',
    phaseHistory: [],
    dryRun: false,
    ...overrides,
  }
}

describe('publishPR', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-publisher-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))

    // Insert issue_link row
    db.prepare(
      "INSERT INTO issue_links (repo, issue_number, branch_name, branch_slug) VALUES ('org/repo', 1, 'orch/1-fix-bug', 'fix-bug')",
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a new PR when none exists', async () => {
    const forge = makeMockForge()

    const result = await publishPR(makeCtx(), forge, db)

    expect(mockPushBranch).toHaveBeenCalledWith('/tmp/wt', 'orch/1-fix-bug')
    expect(forge.createPR).toHaveBeenCalledWith('org/repo', expect.objectContaining({
      headBranch: 'orch/1-fix-bug',
      baseBranch: 'main',
    }))
    expect(result.created).toBe(true)
    expect(result.prNumber).toBe(10)
  })

  it('updates existing PR found via DB', async () => {
    // Set pr_number in DB
    db.prepare('UPDATE issue_links SET pr_number = 5 WHERE repo = ? AND issue_number = ?').run('org/repo', 1)

    const forge = makeMockForge({
      updatePR: vi.fn().mockResolvedValue(makePR({ number: 5 })),
    })

    const result = await publishPR(makeCtx(), forge, db)

    expect(forge.updatePR).toHaveBeenCalledWith('org/repo', 5, expect.any(Object))
    expect(forge.createPR).not.toHaveBeenCalled()
    expect(result.created).toBe(false)
    expect(result.prNumber).toBe(5)
  })

  it('updates existing PR found via API fallback', async () => {
    const existingPR = makePR({ number: 7, url: 'https://github.com/org/repo/pull/7' })
    const forge = makeMockForge({
      findPRByBranch: vi.fn().mockResolvedValue(existingPR),
      updatePR: vi.fn().mockResolvedValue(existingPR),
    })

    const result = await publishPR(makeCtx(), forge, db)

    expect(forge.findPRByBranch).toHaveBeenCalledWith('org/repo', 'orch/1-fix-bug')
    expect(forge.updatePR).toHaveBeenCalledWith('org/repo', 7, expect.any(Object))
    expect(result.created).toBe(false)
  })

  it('saves PR number to DB on create', async () => {
    const forge = makeMockForge({
      createPR: vi.fn().mockResolvedValue(makePR({ number: 15, url: 'https://github.com/org/repo/pull/15' })),
    })

    await publishPR(makeCtx(), forge, db)

    const row = db.prepare('SELECT pr_number, pr_url FROM issue_links WHERE repo = ? AND issue_number = ?')
      .get('org/repo', 1) as { pr_number: number; pr_url: string }
    expect(row.pr_number).toBe(15)
    expect(row.pr_url).toBe('https://github.com/org/repo/pull/15')
  })

  it('pushes branch before creating PR', async () => {
    const callOrder: string[] = []
    mockPushBranch.mockImplementation(async () => { callOrder.push('push') })
    const forge = makeMockForge({
      createPR: vi.fn().mockImplementation(async () => {
        callOrder.push('createPR')
        return makePR()
      }),
    })

    await publishPR(makeCtx(), forge, db)

    expect(callOrder).toEqual(['push', 'createPR'])
  })

  it('propagates push failure', async () => {
    mockPushBranch.mockRejectedValueOnce(new Error('Push failed'))
    const forge = makeMockForge()

    await expect(publishPR(makeCtx(), forge, db)).rejects.toThrow('Push failed')
    expect(forge.createPR).not.toHaveBeenCalled()
  })

  it('PR title follows format', async () => {
    const forge = makeMockForge()

    await publishPR(makeCtx(), forge, db)

    expect(forge.createPR).toHaveBeenCalledWith('org/repo', expect.objectContaining({
      title: '[night-orch] #1 Fix bug',
    }))
  })

  it('PR body does not contain AI attribution', async () => {
    const forge = makeMockForge()

    await publishPR(makeCtx(), forge, db)

    const call = vi.mocked(forge.createPR).mock.calls[0]!
    const body = call[1].body
    expect(body).not.toContain('Generated by')
    expect(body).toContain('Closes #1')
  })
})
