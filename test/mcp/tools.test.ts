import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerTools, handleToolCall } from '../../src/mcp/tools/index.js'
import type { MCPDependencies } from '../../src/mcp/server.js'
import type { ForgeAdapter, ForgeIssue } from '../../src/forge/types.js'
import { initDatabase } from '../../src/state/db.js'
import { recordHandoff } from '../../src/state/handoffs.js'
import { RunManager } from '../../src/state/runs.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { makeTestConfig } from '../helpers/factories.js'

const EXPECTED_TOOL_NAMES = [
  'night-orch-list-settings',
  'night-orch-set-setting',
  'night-orch-clear-setting',
  'night-orch-status',
  'night-orch-run-detail',
  'night-orch-handoffs',
  'night-orch-list-runs',
  'night-orch-list-inbox',
  'night-orch-cost-report',
  'night-orch-retry',
  'night-orch-cost-override',
  'night-orch-daily-cost-override',
  'night-orch-cost-reset',
  'night-orch-daily-cost-reset',
  'night-orch-sync',
  'night-orch-cleanup',
  'night-orch-labels-init',
  'night-orch-delete-entry',
  'night-orch-poll',
  'night-orch-list-issues',
  'night-orch-stream-events',
  'night-orch-rebase',
  'night-orch-continue',
  'night-orch-update',
  'night-orch-file-loop',
]

describe('MCP Tools', () => {
  let tmpDir: string
  let db: Database.Database
  let deps: MCPDependencies

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-mcp-test-'))
    const dbPath = join(tmpDir, 'test.db')
    db = initDatabase(dbPath)
    deps = { db, config: makeTestConfig(), forgeAdapters: new Map(), poller: null, metrics: null }
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers all expected tools', () => {
    const tools = registerTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(EXPECTED_TOOL_NAMES)
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

  it('file-loop status tool returns empty sessions by default', async () => {
    const result = await handleToolCall('night-orch-file-loop', { action: 'status', repo: 'org/repo' }, deps) as {
      success: boolean
      sessions: unknown[]
    }
    expect(result.success).toBe(true)
    expect(result.sessions).toEqual([])
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

  it('handoffs tool returns run handoffs ordered by id with markdown content', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 42,
      issueNodeId: '',
      planner: 'claude',
      coder: 'codex',
      reviewer: 'claude',
    })
    recordHandoff(db, {
      runId: run.id,
      attemptId: run.id,
      stepId: 'plan',
      fromRole: 'planner',
      toRole: 'coder',
      kind: 'plan',
      summary: 'Plan: Fix issue',
      contentMd: '## Plan\n\nObjective: Fix issue',
      contentJson: { objective: 'Fix issue' },
    })
    recordHandoff(db, {
      runId: run.id,
      attemptId: run.id,
      stepId: 'review',
      fromRole: 'reviewer',
      toRole: 'system',
      kind: 'review-findings',
      summary: 'Review: APPROVED',
      contentMd: '## Review Findings',
      contentJson: { verdict: 'APPROVED' },
      tokenUsage: { promptTokens: 10, completionTokens: 5 },
    })

    const result = await handleToolCall('night-orch-handoffs', { runId: run.id }, deps) as {
      count: number
      handoffs: Array<{
        stepId: string
        kind: string
        summary: string
        contentMd: string
        contentJson: unknown
        tokenUsage: unknown
      }>
    }

    expect(result.count).toBe(2)
    expect(result.handoffs.map((handoff) => handoff.stepId)).toEqual(['plan', 'review'])
    expect(result.handoffs[0]).toMatchObject({
      kind: 'plan',
      summary: 'Plan: Fix issue',
      contentMd: '## Plan\n\nObjective: Fix issue',
      contentJson: { objective: 'Fix issue' },
      tokenUsage: null,
    })
    expect(result.handoffs[1]).toMatchObject({
      kind: 'review-findings',
      tokenUsage: { promptTokens: 10, completionTokens: 5 },
    })
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

  it('list-inbox returns active human-action triage buckets', async () => {
    const runManager = new RunManager(db)
    const reviewReady = runManager.create({
      repo: 'org/repo',
      issueNumber: 11,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(reviewReady.id, { status: 'review_ready', prNumber: 411 })

    const needsHuman = runManager.create({
      repo: 'org/repo',
      issueNumber: 12,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(needsHuman.id, { status: 'blocked', blockReason: 'reviewer_blocked' })

    const blocked = runManager.create({
      repo: 'org/repo',
      issueNumber: 13,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(blocked.id, { status: 'blocked', blockReason: 'merge_conflict' })

    const errored = runManager.create({
      repo: 'org/repo',
      issueNumber: 14,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(errored.id, { status: 'error', lastError: 'verify failed' })

    const result = await handleToolCall(
      'night-orch-list-inbox',
      { repo: 'org/repo', limit: 20, offset: 0 },
      deps,
    ) as {
      count: number
      triageCounts: Record<string, number>
      items: Array<{
        runId: string
        triage: string
        status: string
        recommendedCommand: string | null
        availableCommands: string[]
      }>
    }

    expect(result.count).toBe(4)
    expect(result.triageCounts).toMatchObject({
      needs_human: 1,
      review_ready: 1,
      blocked: 1,
      error: 1,
    })
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: reviewReady.id, triage: 'review_ready', status: 'review_ready' }),
        expect.objectContaining({ runId: needsHuman.id, triage: 'needs_human', status: 'blocked' }),
        expect.objectContaining({ runId: blocked.id, triage: 'blocked', status: 'blocked' }),
        expect.objectContaining({ runId: errored.id, triage: 'error', status: 'error' }),
      ]),
    )

    const reviewReadyItem = result.items.find((item) => item.runId === reviewReady.id)
    expect(reviewReadyItem?.recommendedCommand).toBe('/orch continue')
    expect(reviewReadyItem?.availableCommands).toEqual(['/orch continue', '/orch retry'])

    const needsHumanItem = result.items.find((item) => item.runId === needsHuman.id)
    expect(needsHumanItem?.recommendedCommand).toBe('/orch continue')
    expect(needsHumanItem?.availableCommands).toEqual(['/orch continue', '/orch retry'])

    const blockedItem = result.items.find((item) => item.runId === blocked.id)
    expect(blockedItem?.recommendedCommand).toBe('/orch continue')
    expect(blockedItem?.availableCommands).toEqual(['/orch continue', '/orch retry'])

    const erroredItem = result.items.find((item) => item.runId === errored.id)
    expect(erroredItem?.recommendedCommand).toBe('/orch retry')
    expect(erroredItem?.availableCommands).toEqual(['/orch retry'])
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
      `INSERT INTO run_log_events (run_id, source, phase, role, event_type, data, created_at)
       VALUES (?, 'agent', 'code', 'coder', 'tool_call', '{"toolName":"Read"}', datetime('now'))`,
    ).run(run.id)
    db.prepare(
      `INSERT INTO run_log_events (run_id, source, phase, role, event_type, data, created_at)
       VALUES (?, 'agent', 'code', 'coder', 'text', '{"text":"Working"}', datetime('now'))`,
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

  it('stream-events supports issue-scoped history across attempts', async () => {
    const runManager = new RunManager(db)
    const firstRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 6,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    db.prepare(
      `INSERT INTO run_log_events (run_id, source, phase, role, event_type, data, created_at)
       VALUES (?, 'agent', 'code', 'coder', 'text', '{"text":"first"}', datetime('now'))`,
    ).run(firstRun.id)
    runManager.update(firstRun.id, { status: 'completed', endedAt: new Date().toISOString() })

    const secondRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 6,
      issueNodeId: '',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    db.prepare(
      `INSERT INTO run_log_events (run_id, source, phase, role, event_type, data, created_at)
       VALUES (?, 'user', NULL, 'web', 'user_action', '{"kind":"retry"}', datetime('now'))`,
    ).run(secondRun.id)

    const result = await handleToolCall('night-orch-stream-events', { repo: 'org/repo', issueNumber: 6 }, deps) as {
      repo: string
      issueNumber: number
      events: Array<{ runId: string; source: string }>
      lastEventId: number
    }

    expect(result.repo).toBe('org/repo')
    expect(result.issueNumber).toBe(6)
    expect(result.events).toHaveLength(2)
    expect(result.events.map((event) => event.runId)).toEqual([firstRun.id, secondRun.id])
    expect(result.events.map((event) => event.source)).toEqual(['agent', 'user'])
    expect(result.lastEventId).toBe(result.events[1]?.id)
  })

  it('unknown tool throws', async () => {
    await expect(handleToolCall('unknown-tool', {}, deps)).rejects.toThrow('Unknown tool')
  })

  it('rejects malformed MCP tool argument types at the boundary', async () => {
    await expect(
      handleToolCall('night-orch-list-runs', { limit: '10' }, deps),
    ).rejects.toThrow('Invalid arguments for night-orch-list-runs')

    await expect(
      handleToolCall('night-orch-set-setting', { key: 42, value: '120' }, deps),
    ).rejects.toThrow('Invalid arguments for night-orch-set-setting')
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
        makeIssue(1, 'First', ['no:ready']),
        makeIssue(2, 'Second', ['no:ready']),
        makeIssue(3, 'Third', ['no:ready']),
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
      const issues = [makeIssue(1, 'First', ['no:ready']), makeIssue(2, 'Second', ['no:ready'])]
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
        includeLabelsAny: ['no:ready'],
        excludeLabelsAny: ['skip-me'],
      }

      const issues = [
        makeIssue(1, 'Eligible', ['no:ready']),
        makeIssue(2, 'Excluded', ['no:ready', 'skip-me']),
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
