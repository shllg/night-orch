import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerTools, handleToolCall } from '../../src/mcp/tools/index.js'
import type { MCPDependencies } from '../../src/mcp/server.js'
import type { ForgeAdapter, ForgeIssue } from '../../src/forge/types.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

function makeMinimalConfig() {
  return {
    version: 1 as const,
    github: { tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: 'https://api.github.com', pollIntervalSeconds: 300, appMentions: {} },
    storage: { dbPath: '', worktreeRoot: '/tmp/wt', logsRoot: '/tmp/logs' },
    notifications: { channels: [{ type: 'console' as const }], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    mcp: { enabled: true, transport: 'stdio' as const },
    repos: [{ repo: 'org/repo', forge: 'github' as const, localPath: '/tmp/repo', baseBranch: 'main', branchPrefix: 'orch', labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked', 'orch:needs-human'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' }, defaults: { planner: 'claude' as const, coder: 'claude' as const, reviewer: 'claude' as const, doneMode: 'pr-ready' as const, notifyPriority: 'normal' as const, prMentions: [] }, verify: [], selectors: { includeLabelsAny: ['orch:ready'], excludeLabelsAny: [] }, agents: {} }],
  }
}

describe('MCP Tools', () => {
  let tmpDir: string
  let db: Database.Database
  let deps: MCPDependencies

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-mcp-test-'))
    const dbPath = join(tmpDir, 'test.db')
    db = initDatabase(dbPath)
    deps = { db, config: makeMinimalConfig() as MCPDependencies['config'], forgeAdapters: new Map(), poller: null, metrics: null }
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers all expected tools', () => {
    const tools = registerTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('night-orch-status')
    expect(names).toContain('night-orch-run-detail')
    expect(names).toContain('night-orch-list-runs')
    expect(names).toContain('night-orch-cost-report')
    expect(names).toContain('night-orch-retry')
    expect(names).toContain('night-orch-sync')
    expect(names).toContain('night-orch-cleanup')
    expect(names).toContain('night-orch-list-issues')
    expect(tools.length).toBe(8)
  })

  it('status tool returns summary', async () => {
    const result = await handleToolCall('night-orch-status', {}, deps)
    const status = result as { activeRuns: number; configuredRepos: string[] }
    expect(status.activeRuns).toBe(0)
    expect(status.configuredRepos).toContain('org/repo')
  })

  it('status tool filters by repo', async () => {
    const runManager = new RunManager(db)
    runManager.create({ repo: 'org/repo', issueNumber: 1, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })
    runManager.create({ repo: 'other/repo', issueNumber: 2, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })

    const result = await handleToolCall('night-orch-status', { repo: 'org/repo' }, deps) as { activeRuns: number }
    expect(result.activeRuns).toBe(1)
  })

  it('run-detail returns run info', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({ repo: 'org/repo', issueNumber: 42, issueNodeId: '', planner: 'claude', coder: 'codex', reviewer: 'claude' })

    const result = await handleToolCall('night-orch-run-detail', { runId: run.id }, deps) as { issueNumber: number }
    expect(result.issueNumber).toBe(42)
  })

  it('run-detail throws for unknown ID', async () => {
    await expect(handleToolCall('night-orch-run-detail', { runId: 'run-nonexistent' }, deps)).rejects.toThrow('Run not found')
  })

  it('list-runs returns filtered results', async () => {
    const runManager = new RunManager(db)
    runManager.create({ repo: 'org/repo', issueNumber: 1, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })
    const r2 = runManager.create({ repo: 'org/repo', issueNumber: 2, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })
    runManager.update(r2.id, { status: 'error' })

    const result = await handleToolCall('night-orch-list-runs', { status: 'queued' }, deps) as { count: number }
    expect(result.count).toBe(1)
  })

  it('cost-report returns breakdown', async () => {
    const result = await handleToolCall('night-orch-cost-report', { days: 7 }, deps) as { totalCostUsd: number; dailyBudgetUsd: number }
    expect(result.totalCostUsd).toBe(0)
    expect(result.dailyBudgetUsd).toBe(50)
  })

  it('unknown tool throws', async () => {
    await expect(handleToolCall('unknown-tool', {}, deps)).rejects.toThrow('Unknown tool')
  })

  describe('list-issues', () => {
    function makeIssue(num: number, title: string, labels: string[] = []): ForgeIssue {
      return {
        number: num,
        nodeId: `node-${num}`,
        title,
        body: '',
        labels,
        assignees: [],
        state: 'open',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        url: `https://github.com/org/repo/issues/${num}`,
      }
    }

    function makeMockAdapter(issues: ForgeIssue[]): ForgeAdapter {
      return {
        listEligibleIssues: vi.fn().mockResolvedValue(issues),
        getIssue: vi.fn(),
        addLabels: vi.fn(),
        removeLabels: vi.fn(),
        commentOnIssue: vi.fn(),
        validateAuth: vi.fn(),
        createPR: vi.fn(),
        updatePR: vi.fn(),
        findPRByBranch: vi.fn(),
        getPRDiff: vi.fn(),
      }
    }

    it('throws when repo has no adapter', async () => {
      await expect(
        handleToolCall('night-orch-list-issues', { repo: 'unknown/repo' }, deps),
      ).rejects.toThrow('No forge adapter configured')
    })

    it('returns issues with orchestrator state', async () => {
      const issues = [makeIssue(1, 'First'), makeIssue(2, 'Second'), makeIssue(3, 'Third')]
      deps.forgeAdapters.set('org/repo', makeMockAdapter(issues))

      // Create a running run for issue 1
      const runManager = new RunManager(db)
      runManager.create({ repo: 'org/repo', issueNumber: 1, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })

      // Create a blocked run for issue 2
      const r2 = runManager.create({ repo: 'org/repo', issueNumber: 2, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })
      runManager.update(r2.id, { status: 'blocked' })

      const result = await handleToolCall('night-orch-list-issues', { repo: 'org/repo' }, deps) as {
        count: number
        issues: Array<{ number: number; state: string; runId: string | null }>
      }

      expect(result.count).toBe(3)

      const i1 = result.issues.find((i) => i.number === 1)
      expect(i1?.state).toBe('running')
      expect(i1?.runId).toBeTruthy()

      const i2 = result.issues.find((i) => i.number === 2)
      expect(i2?.state).toBe('blocked')

      const i3 = result.issues.find((i) => i.number === 3)
      expect(i3?.state).toBe('eligible')
      expect(i3?.runId).toBeNull()
    })

    it('filters by state', async () => {
      const issues = [makeIssue(1, 'First'), makeIssue(2, 'Second')]
      deps.forgeAdapters.set('org/repo', makeMockAdapter(issues))

      const runManager = new RunManager(db)
      runManager.create({ repo: 'org/repo', issueNumber: 1, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })

      const result = await handleToolCall('night-orch-list-issues', { repo: 'org/repo', filter: 'eligible' }, deps) as {
        count: number
        issues: Array<{ number: number }>
      }

      expect(result.count).toBe(1)
      expect(result.issues[0]?.number).toBe(2)
    })
  })
})
