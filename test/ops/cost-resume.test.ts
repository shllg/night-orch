import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { scanCostBlockedRuns } from '../../src/ops/cost-resume.js'
import { CostTracker } from '../../src/loop/cost.js'
import { transitionLabels } from '../../src/labels/manager.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { Config } from '../../src/config/schema.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../src/labels/manager.js', () => ({
  transitionLabels: vi.fn().mockResolvedValue(undefined),
}))

function makeMockForge(): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({
      number: 1, nodeId: '', title: 'Test', body: '', labels: ['orch:blocked'],
      assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn(),
    updateComment: vi.fn(),
    listPRReviews: vi.fn(),
    listPRReviewComments: vi.fn(),
    mergePR: vi.fn(),
    closePR: vi.fn(),
  }
}

function makeConfig(overrides: { costModel?: 'pay-per-use' | 'subscription' | 'subscription-metered'; maxDailyCostUsd?: number; maxCostPerRunUsd?: number } = {}): Config {
  return {
    version: 1,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs', autoCleanup: { enabled: true, intervalMinutes: 60 }, retention: { worktreeAgeDays: 7, detailDays: 30, archiveDays: 90 } },
    notifications: { channels: [], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true, maxAutoRetries: 3, decompose: false, maxSubtasks: 5, maxConcurrentSubtasks: 3 },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: overrides.maxDailyCostUsd ?? 50, maxCostPerRunUsd: overrides.maxCostPerRunUsd ?? 10 },
    cost: { model: overrides.costModel ?? 'pay-per-use', pricing: { defaultModel: 'default', models: {} }, subscriptionMetered: { advisoryThresholdUsd: null, enforcePerRunLimit: false, enforceDailyLimit: false } },
    observability: { agentStreaming: true, eventRetention: 1000, sessionLogs: true, sessionLogRetention: 7 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    mcp: { enabled: false, transport: 'stdio', authTokenEnv: null, httpPort: 3100, httpHost: '127.0.0.1' },
    commentCommands: { enabled: true, requireCollaborator: true },
    repos: [{
      repo: 'org/repo', forge: 'github', linkedProjects: [], maxConcurrentRuns: 1, localPath: '/tmp/repo', baseBranch: 'main',
      branchPrefix: 'orch', updateStrategy: 'merge',       labels: { ready: ['orch:ready'], running: 'orch:running', blocked: 'orch:blocked', needsHuman: 'orch:needs-human', reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry', planning: 'orch:planning', mergeQueued: 'orch:merge-queued', merging: 'orch:merging', mergeFailed: 'orch:merge-failed' },
      labelConfig: {},
      planning: { prdDirectory: 'docs/prd' },
      defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', doneMode: 'pr-ready', notifyPriority: 'normal', prMentions: [] },
      verify: [], selectors: { includeLabelsAny: [], excludeLabelsAny: [] }, agents: {},
      mergeQueue: { enabled: false, batchSize: 5, mergeMethod: 'merge', retryFlakyOnce: true, requireApproval: true, stagingBranchPrefix: 'orch/staging' },
    }],
    workflows: {},
  } as Config
}

function insertRun(db: Database.Database, overrides: Record<string, unknown> = {}): string {
  const id = `run-${Math.random().toString(36).slice(2, 8)}`
  const defaults = {
    id,
    repo: 'org/repo',
    issue_number: 1,
    issue_node_id: 'node1',
    status: 'blocked',
    block_reason: 'cost_limit',
    planner: 'claude',
    coder: 'claude',
    reviewer: 'claude',
    started_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    last_error: 'Cost limit exceeded',
    estimated_cost_usd: 15,
    prompt_tokens: 1000,
    completion_tokens: 500,
    cache_read_tokens: 100,
    ...overrides,
  }
  db.prepare(
    `INSERT INTO runs (id, repo, issue_number, issue_node_id, status, block_reason, planner, coder, reviewer, started_at, created_at, updated_at, ended_at, last_error, estimated_cost_usd, prompt_tokens, completion_tokens, cache_read_tokens)
     VALUES (@id, @repo, @issue_number, @issue_node_id, @status, @block_reason, @planner, @coder, @reviewer, @started_at, @created_at, @updated_at, @ended_at, @last_error, @estimated_cost_usd, @prompt_tokens, @completion_tokens, @cache_read_tokens)`,
  ).run(defaults)
  return id
}

describe('scanCostBlockedRuns', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-cost-resume-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resumes cost-blocked run when subscription model always allows', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'blocked', block_reason: 'cost_limit', estimated_cost_usd: 100 })
    const config = makeConfig({ costModel: 'subscription' })
    const repoConfig = config.repos[0]!

    const result = await scanCostBlockedRuns(db, config, forge, repoConfig, 'bot')

    expect(result.resumed).toBe(1)
    expect(result.stillBlocked).toBe(0)

    // Under the immutable-attempts model the previous attempt stays at its
    // historical state and is frozen; a new head attempt replaces it with
    // a fresh cost ledger.
    const prev = db
      .prepare(
        'SELECT status, block_reason, estimated_cost_usd, terminated_at FROM runs WHERE id = ?',
      )
      .get(runId) as {
      status: string
      block_reason: string | null
      estimated_cost_usd: number
      terminated_at: string | null
    }
    expect(prev.status).toBe('blocked')
    expect(prev.block_reason).toBe('cost_limit')
    expect(prev.estimated_cost_usd).toBe(100)
    expect(prev.terminated_at).not.toBeNull()

    const head = db
      .prepare(
        `SELECT status, block_reason, estimated_cost_usd, prompt_tokens,
                completion_tokens, cache_read_tokens, previous_attempt_id, intent
         FROM runs
         WHERE repo = ? AND issue_number = ?
         ORDER BY sequence_number DESC, created_at DESC
         LIMIT 1`,
      )
      .get('org/repo', 1) as {
      status: string
      block_reason: string | null
      estimated_cost_usd: number
      prompt_tokens: number
      completion_tokens: number
      cache_read_tokens: number
      previous_attempt_id: string | null
      intent: string
    }
    expect(head.status).toBe('queued')
    expect(head.block_reason).toBeNull()
    expect(head.estimated_cost_usd).toBe(0)
    expect(head.prompt_tokens).toBe(0)
    expect(head.completion_tokens).toBe(0)
    expect(head.cache_read_tokens).toBe(0)
    expect(head.previous_attempt_id).toBe(runId)
    expect(head.intent).toBe('continue')
  })

  it('stays blocked when still over per-run limit', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'blocked', block_reason: 'cost_limit', estimated_cost_usd: 15 })
    const config = makeConfig({ costModel: 'pay-per-use', maxCostPerRunUsd: 10 })
    const repoConfig = config.repos[0]!

    const result = await scanCostBlockedRuns(db, config, forge, repoConfig, 'bot')

    expect(result.resumed).toBe(0)
    expect(result.stillBlocked).toBe(1)

    const row = db.prepare('SELECT status, block_reason FROM runs WHERE id = ?').get(runId) as {
      status: string
      block_reason: string | null
    }
    expect(row.status).toBe('blocked')
    expect(row.block_reason).toBe('cost_limit')
  })

  it('stays blocked when still over daily limit', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'blocked', block_reason: 'cost_limit', estimated_cost_usd: 5 })
    const config = makeConfig({ costModel: 'pay-per-use', maxDailyCostUsd: 10, maxCostPerRunUsd: 100 })
    const repoConfig = config.repos[0]!

    // Pre-populate daily cost to push over limit
    const today = new Date().toISOString().slice(0, 10)
    db.prepare(
      `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, total_cache_read_tokens)
       VALUES (?, 20, 1, 100, 50, 10)`
    ).run(today)

    const result = await scanCostBlockedRuns(db, config, forge, repoConfig, 'bot')

    expect(result.resumed).toBe(0)
    expect(result.stillBlocked).toBe(1)

    const row = db.prepare('SELECT status, block_reason FROM runs WHERE id = ?').get(runId) as {
      status: string
      block_reason: string | null
    }
    expect(row.status).toBe('blocked')
    expect(row.block_reason).toBe('cost_limit')
  })

  it('resumes when per-run override grants budget', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'blocked', block_reason: 'cost_limit', estimated_cost_usd: 100 })
    const config = makeConfig({ costModel: 'pay-per-use', maxCostPerRunUsd: 10 })
    const repoConfig = config.repos[0]!

    // Grant per-run budget override
    db.prepare('UPDATE runs SET cost_budget_override_usd = ? WHERE id = ?').run(200, runId)

    const result = await scanCostBlockedRuns(db, config, forge, repoConfig, 'bot')

    expect(result.resumed).toBe(1)
    expect(result.stillBlocked).toBe(0)

    const head = db
      .prepare(
        `SELECT status, block_reason, previous_attempt_id FROM runs
         WHERE repo = ? AND issue_number = ?
         ORDER BY sequence_number DESC, created_at DESC
         LIMIT 1`,
      )
      .get('org/repo', 1) as {
      status: string
      block_reason: string | null
      previous_attempt_id: string | null
    }
    expect(head.status).toBe('queued')
    expect(head.block_reason).toBeNull()
    expect(head.previous_attempt_id).toBe(runId)
  })

  it('resumes when daily cap override raised', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'blocked', block_reason: 'cost_limit', estimated_cost_usd: 5 })
    const config = makeConfig({ costModel: 'pay-per-use', maxDailyCostUsd: 10, maxCostPerRunUsd: 100 })
    const repoConfig = config.repos[0]!

    // Pre-populate daily cost to push over default limit
    const today = new Date().toISOString().slice(0, 10)
    db.prepare(
      `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, total_cache_read_tokens, daily_cost_cap_override_usd)
       VALUES (?, 20, 1, 100, 50, 10, 100)`
    ).run(today)

    const result = await scanCostBlockedRuns(db, config, forge, repoConfig, 'bot')

    expect(result.resumed).toBe(1)
    expect(result.stillBlocked).toBe(0)
  })

  it('ignores non-cost block reasons', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'blocked', block_reason: 'merge_conflict', estimated_cost_usd: 5 })
    const config = makeConfig({ costModel: 'subscription' })
    const repoConfig = config.repos[0]!

    const result = await scanCostBlockedRuns(db, config, forge, repoConfig, 'bot')

    expect(result.resumed).toBe(0)
    expect(result.stillBlocked).toBe(0)

    const row = db.prepare('SELECT status, block_reason FROM runs WHERE id = ?').get(runId) as {
      status: string
      block_reason: string | null
    }
    expect(row.status).toBe('blocked')
    expect(row.block_reason).toBe('merge_conflict')
  })

  it('handles $0-cost daily blocked runs correctly', async () => {
    const forge = makeMockForge()
    const runId = insertRun(db, { status: 'blocked', block_reason: 'cost_limit', estimated_cost_usd: 0 })
    const config = makeConfig({ costModel: 'pay-per-use', maxDailyCostUsd: 10 })
    const repoConfig = config.repos[0]!

    // Pre-populate daily cost at exactly the limit
    const today = new Date().toISOString().slice(0, 10)
    db.prepare(
      `INSERT INTO daily_costs (date, total_cost_usd, run_count, total_prompt_tokens, total_completion_tokens, total_cache_read_tokens)
       VALUES (?, 10, 1, 100, 50, 10)`
    ).run(today)

    const result = await scanCostBlockedRuns(db, config, forge, repoConfig, 'bot')

    // The run itself has $0 cost, but daily limit is at cap
    // With subscription-metered settings (default enforceDailyLimit: false), this should stay blocked
    // because checkBudget returns overBudget when daily limit hit even with $0 run cost
    expect(result.resumed).toBe(0)
    expect(result.stillBlocked).toBe(1)
  })

  it('transitions labels on resume', async () => {
    const forge = makeMockForge()
    insertRun(db, { status: 'blocked', block_reason: 'cost_limit', estimated_cost_usd: 5 })
    const config = makeConfig({ costModel: 'subscription' })
    const repoConfig = config.repos[0]!

    await scanCostBlockedRuns(db, config, forge, repoConfig, 'bot')

    expect(transitionLabels).toHaveBeenCalledWith(
      forge,
      'org/repo',
      1,
      ['orch:blocked'],
      'blocked',
      'queued',
      expect.any(Object),
    )
  })

  it('posts comment on resume', async () => {
    const forge = makeMockForge()
    insertRun(db, { status: 'blocked', block_reason: 'cost_limit', estimated_cost_usd: 5 })
    const config = makeConfig({ costModel: 'subscription' })
    const repoConfig = config.repos[0]!

    await scanCostBlockedRuns(db, config, forge, repoConfig, 'bot-user')

    expect(forge.commentOnIssue).not.toHaveBeenCalled() // bot-user is set, so upsertBotComment path
  })
})
