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
    notifications: { channels: [{ type: 'console' as const }], events: { onRunStarted: false, onBlocked: true, onPrReady: true, onPrUpdated: true, onError: true, onRetryExhausted: true } },
    loop: { maxReviewIterations: 4, maxTotalAgentPasses: 10, stopOnPlannerFailure: true, requireVerificationPass: true, reviewApprovalKeyword: 'APPROVED', reviewNeedsChangesKeyword: 'CHANGES_REQUIRED', blockOnAmbiguousReview: true },
    security: { maxChangedFiles: 50, maxChangedLines: 5000, maxDailyCostUsd: 50, maxCostPerRunUsd: 10 },
    workerProfiles: {},
    metrics: { enabled: false, port: 9090, host: '127.0.0.1' },
    mcp: { enabled: true, transport: 'stdio' as const, authTokenEnv: null },
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
    expect(names).toContain('night-orch-list-settings')
    expect(names).toContain('night-orch-set-setting')
    expect(names).toContain('night-orch-clear-setting')
    expect(names).toContain('night-orch-status')
    expect(names).toContain('night-orch-run-detail')
    expect(names).toContain('night-orch-list-runs')
    expect(names).toContain('night-orch-cost-report')
    expect(names).toContain('night-orch-retry')
    expect(names).toContain('night-orch-sync')
    expect(names).toContain('night-orch-cleanup')
    expect(names).toContain('night-orch-labels-init')
    expect(names).toContain('night-orch-delete-entry')
    expect(names).toContain('night-orch-poll')
    expect(names).toContain('night-orch-list-issues')
    expect(names).toContain('night-orch-stream-events')
    expect(names).toContain('night-orch-rebase')
    expect(names).toContain('night-orch-continue')
    expect(names).toContain('night-orch-cost-override')
    expect(names).toContain('night-orch-daily-cost-override')
    expect(names).toContain('night-orch-cost-reset')
    expect(names).toContain('night-orch-daily-cost-reset')
    expect(tools.length).toBe(22)
  })

  it('settings tools list/set/clear runtime overrides', async () => {
    const listedBefore = await handleToolCall('night-orch-list-settings', {}, deps) as {
      settings: Array<{ key: string; source: string; effectiveValue: number | boolean | string | null }>
    }
    const pollSettingBefore = listedBefore.settings.find((setting) => setting.key === 'github.pollIntervalSeconds')
    expect(pollSettingBefore).toBeDefined()
    expect(pollSettingBefore?.source).toBe('base')

    const setResult = await handleToolCall(
      'night-orch-set-setting',
      { key: 'github.pollIntervalSeconds', value: '120' },
      deps,
    ) as { changed: boolean; setting: { key: string; effectiveValue: number; source: string } }
    expect(setResult.changed).toBe(true)
    expect(setResult.setting.key).toBe('github.pollIntervalSeconds')
    expect(setResult.setting.effectiveValue).toBe(120)
    expect(setResult.setting.source).toBe('override')

    const listedAfter = await handleToolCall('night-orch-list-settings', {}, deps) as {
      settings: Array<{ key: string; source: string; effectiveValue: number | boolean | string | null }>
    }
    const pollSettingAfter = listedAfter.settings.find((setting) => setting.key === 'github.pollIntervalSeconds')
    expect(pollSettingAfter?.effectiveValue).toBe(120)
    expect(pollSettingAfter?.source).toBe('override')

    const clearResult = await handleToolCall(
      'night-orch-clear-setting',
      { key: 'github.pollIntervalSeconds' },
      deps,
    ) as { changed: boolean; setting: { key: string; effectiveValue: number; source: string } }
    expect(clearResult.changed).toBe(true)
    expect(clearResult.setting.key).toBe('github.pollIntervalSeconds')
    expect(clearResult.setting.effectiveValue).toBe(300)
    expect(clearResult.setting.source).toBe('base')
  })

  it('redacts sensitive worker profile env values in settings list output', async () => {
    deps.config.workerProfiles = {
      codexCli: {
        type: 'codex',
        command: 'codex',
        args: ['exec'],
        workerTimeoutSeconds: 900,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {
          OPENAI_API_KEY: 'top-secret',
          MODE: 'dev',
        },
      },
    }

    const listed = await handleToolCall('night-orch-list-settings', {}, deps) as {
      settings: Array<{ key: string; effectiveValue: unknown }>
    }
    const workerProfiles = listed.settings.find((setting) => setting.key === 'workerProfiles')
    expect(workerProfiles?.effectiveValue).toMatchObject({
      codexCli: {
        env: {
          OPENAI_API_KEY: '[redacted]',
          MODE: '[redacted]',
        },
      },
    })
  })

  it('rejects malformed json structures and read-only runtime setting mutations', async () => {
    await expect(handleToolCall(
      'night-orch-set-setting',
      { key: 'notifications.channels', value: '{}' },
      deps,
    )).rejects.toThrow('notifications.channels has invalid structure')

    await expect(handleToolCall(
      'night-orch-set-setting',
      { key: 'storage.dbPath', value: '/tmp/other.db' },
      deps,
    )).rejects.toThrow('storage.dbPath is read-only at runtime and cannot be overridden')
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
    runManager.create({
      repo: 'org/repo',
      issueNumber: 1,
      issueTitle: 'Queue run title',
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    const r2 = runManager.create({ repo: 'org/repo', issueNumber: 2, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })
    runManager.update(r2.id, { status: 'error', prNumber: 42, lastError: 'verify failed' })

    const result = await handleToolCall('night-orch-list-runs', { status: 'queued' }, deps) as {
      count: number
      runs: Array<{ issueTitle: string | null; prNumber: number | null; lastError: string | null }>
    }
    expect(result.count).toBe(1)
    expect(result.runs[0]).toMatchObject({
      issueTitle: 'Queue run title',
      prNumber: null,
      lastError: null,
    })

    const errored = await handleToolCall('night-orch-list-runs', { status: 'error' }, deps) as {
      count: number
      runs: Array<{ prNumber: number | null; lastError: string | null }>
    }
    expect(errored.count).toBe(1)
    expect(errored.runs[0]).toMatchObject({
      prNumber: 42,
      lastError: 'verify failed',
    })
  })

  it('list-runs includes tracked issues with no run rows', async () => {
    db.prepare(
      `INSERT INTO issues (
        repo, issue_number, issue_node_id, issue_title, status,
        iteration_count, estimated_cost_usd, run_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'org/repo',
      58,
      'node-58',
      'Issue missing',
      'queued',
      0,
      0,
      0,
      '2026-04-01T12:00:00.000Z',
      '2026-04-01T12:00:00.000Z',
    )

    const result = await handleToolCall('night-orch-list-runs', { repo: 'org/repo' }, deps) as {
      runs: Array<{ issue: number; status: string; runId: string; hasRun: boolean }>
    }
    const trackedIssue = result.runs.find((run) => run.issue === 58)

    expect(trackedIssue).toBeDefined()
    expect(trackedIssue?.status).toBe('queued')
    expect(trackedIssue?.hasRun).toBe(false)
    expect(trackedIssue?.runId.startsWith('issue:')).toBe(true)
  })

  it('list-runs returns completed runs for resolved issues when status filter is completed', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 91,
      issueNodeId: 'node-91',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(run.id, {
      status: 'completed',
      endedAt: '2026-04-02T12:10:00.000Z',
    })

    const result = await handleToolCall(
      'night-orch-list-runs',
      { repo: 'org/repo', status: 'completed' },
      deps,
    ) as { count: number; runs: Array<{ runId: string; issue: number; status: string; hasRun: boolean }> }

    expect(result.count).toBe(1)
    expect(result.runs[0]).toMatchObject({
      runId: run.id,
      issue: 91,
      status: 'completed',
      hasRun: true,
    })
  })

  it('list-runs supports paginated history views', async () => {
    const runManager = new RunManager(db)

    const completed = runManager.create({
      repo: 'org/repo',
      issueNumber: 101,
      issueTitle: 'Completed history row',
      issueNodeId: 'node-101',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(completed.id, {
      status: 'completed',
      endedAt: '2026-04-03T12:00:00.000Z',
    })

    const errored = runManager.create({
      repo: 'org/repo',
      issueNumber: 102,
      issueTitle: 'Errored history row',
      issueNodeId: 'node-102',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(errored.id, {
      status: 'error',
      endedAt: '2026-04-03T12:05:00.000Z',
      lastError: 'verify failed',
    })

    const blocked = runManager.create({
      repo: 'org/repo',
      issueNumber: 103,
      issueTitle: 'Blocked history row',
      issueNodeId: 'node-103',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(blocked.id, {
      status: 'blocked',
      endedAt: '2026-04-03T12:10:00.000Z',
      lastError: 'needs input',
    })

    const pageOne = await handleToolCall(
      'night-orch-list-runs',
      { view: 'all', limit: 2, offset: 0 },
      deps,
    ) as {
      count: number
      hasMore: boolean
      nextOffset: number | null
      runs: Array<{ runId: string; status: string }>
    }

    expect(pageOne.count).toBe(2)
    expect(pageOne.hasMore).toBe(true)
    expect(pageOne.nextOffset).toBe(2)

    const pageTwo = await handleToolCall(
      'night-orch-list-runs',
      { view: 'all', limit: 2, offset: pageOne.nextOffset ?? 0 },
      deps,
    ) as {
      count: number
      hasMore: boolean
      runs: Array<{ runId: string; status: string }>
    }

    expect(pageTwo.count).toBe(1)
    expect(pageTwo.hasMore).toBe(false)
    expect([...pageOne.runs, ...pageTwo.runs].map((run) => run.runId)).toContain(completed.id)
    expect([...pageOne.runs, ...pageTwo.runs].map((run) => run.runId)).toContain(errored.id)
    expect([...pageOne.runs, ...pageTwo.runs].map((run) => run.runId)).toContain(blocked.id)

    const failed = await handleToolCall(
      'night-orch-list-runs',
      { view: 'failed', limit: 10, offset: 0 },
      deps,
    ) as {
      runs: Array<{ runId: string; status: string }>
    }
    expect(failed.runs.map((run) => run.status)).toEqual(['blocked', 'error'])
    expect(failed.runs.map((run) => run.runId)).not.toContain(completed.id)
  })

  it('cost-report returns breakdown', async () => {
    const result = await handleToolCall('night-orch-cost-report', { days: 7 }, deps) as { totalCostUsd: number; dailyBudgetUsd: number }
    expect(result.totalCostUsd).toBe(0)
    expect(result.dailyBudgetUsd).toBe(50)
  })

  it('labels-init tool supports dry-run for a configured repo', async () => {
    const result = await handleToolCall(
      'night-orch-labels-init',
      { repo: 'org/repo', dryRun: true },
      deps,
    ) as {
      dryRun: boolean
      targetRepo: string | null
      labelsProcessed: number
      failures: number
      message: string
    }

    expect(result.dryRun).toBe(true)
    expect(result.targetRepo).toBe('org/repo')
    expect(result.labelsProcessed).toBeGreaterThan(0)
    expect(result.failures).toBe(0)
    expect(result.message).toContain('labels-init complete')
  })

  it('delete-entry tool removes local issue state', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 17,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    db.prepare(
      `INSERT INTO leases (repo, issue_number, lease_owner, leased_until)
       VALUES (?, ?, ?, datetime('now', '+1 hour'))`,
    ).run('org/repo', 17, 'test-owner')
    db.prepare(
      `INSERT INTO command_tracking (repo, issue_number, comment_id, command)
       VALUES (?, ?, ?, ?)`,
    ).run('org/repo', 17, 99, 'retry:applied')

    const result = await handleToolCall(
      'night-orch-delete-entry',
      { repo: 'org/repo', issueNumber: 17 },
      deps,
    ) as { runsDeleted: number; issuesDeleted: number; leasesDeleted: number; commandTrackingDeleted: number }

    expect(result.runsDeleted).toBe(1)
    expect(result.issuesDeleted).toBe(1)
    expect(result.leasesDeleted).toBe(1)
    expect(result.commandTrackingDeleted).toBe(1)
    expect(db.prepare('SELECT 1 FROM runs WHERE id = ?').get(run.id)).toBeUndefined()
  })

  it('stream-events returns events and supports since cursor', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({ repo: 'org/repo', issueNumber: 5, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })

    db.prepare(
      `INSERT INTO agent_events (run_id, phase, role, event_type, data, created_at)
       VALUES (?, 'code', 'coder', 'tool_call', '{"toolName":"Read"}', datetime('now'))`,
    ).run(run.id)
    db.prepare(
      `INSERT INTO agent_events (run_id, phase, role, event_type, data, created_at)
       VALUES (?, 'code', 'coder', 'text', '{"text":"Working"}', datetime('now'))`,
    ).run(run.id)

    const first = await handleToolCall('night-orch-stream-events', { runId: run.id, limit: 1 }, deps) as {
      events: Array<{ id: number }>
      lastEventId: number
    }
    expect(first.events).toHaveLength(1)
    expect(first.lastEventId).toBe(first.events[0]!.id)

    const second = await handleToolCall('night-orch-stream-events', { runId: run.id, since: first.lastEventId }, deps) as {
      events: Array<{ id: number }>
      lastEventId: number
    }
    expect(second.events).toHaveLength(1)
    expect(second.events[0]!.id).toBeGreaterThan(first.lastEventId)
    expect(second.lastEventId).toBe(second.events[0]!.id)
  })

  it('unknown tool throws', async () => {
    await expect(handleToolCall('unknown-tool', {}, deps)).rejects.toThrow('Unknown tool')
  })

  it('requires auth token for mutating tools when configured', async () => {
    process.env['MCP_TOKEN'] = 'secret'
    deps.config.mcp.authTokenEnv = 'MCP_TOKEN'
    await expect(
      handleToolCall('night-orch-sync', { dryRun: true }, deps),
    ).rejects.toThrow('Unauthorized')
    delete process.env['MCP_TOKEN']
  })

  it('accepts valid auth token for mutating tools', async () => {
    process.env['MCP_TOKEN'] = 'secret'
    deps.config.mcp.authTokenEnv = 'MCP_TOKEN'
    await expect(
      handleToolCall('night-orch-sync', { dryRun: true, authToken: 'secret' }, deps),
    ).resolves.toBeTruthy()
    delete process.env['MCP_TOKEN']
  })

  it('poll tool triggers running headless poller when available', async () => {
    const triggerPollCycle = vi.fn().mockReturnValue({
      accepted: true as const,
      state: 'woke-sleeper' as const,
    })
    deps.poller = { triggerPollCycle }

    const result = await handleToolCall('night-orch-poll', {}, deps) as {
      success: boolean
      queued: boolean
      state: string
      processed: null
      errors: null
    }

    expect(triggerPollCycle).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      success: true,
      queued: true,
      state: 'woke-sleeper',
      processed: null,
      errors: null,
    })
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
      const issues = [
        makeIssue(1, 'First', ['orch:ready']),
        makeIssue(2, 'Second', ['orch:ready']),
        makeIssue(3, 'Third', ['orch:ready']),
      ]
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
      const issues = [makeIssue(1, 'First', ['orch:ready']), makeIssue(2, 'Second', ['orch:ready'])]
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

    it('applies local selector filters before returning issues', async () => {
      deps.config.repos[0]!.selectors = {
        includeLabelsAny: ['orch:ready'],
        excludeLabelsAny: ['skip-me'],
      }

      const issues = [
        makeIssue(1, 'Eligible', ['orch:ready']),
        makeIssue(2, 'Excluded', ['orch:ready', 'skip-me']),
        makeIssue(3, 'Missing include', ['bug']),
      ]
      deps.forgeAdapters.set('org/repo', makeMockAdapter(issues))

      const result = await handleToolCall('night-orch-list-issues', { repo: 'org/repo' }, deps) as {
        count: number
        issues: Array<{ number: number }>
      }

      expect(result.count).toBe(1)
      expect(result.issues[0]?.number).toBe(1)
    })
  })
})
