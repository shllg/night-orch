import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { registerResources, handleResourceRead } from '../../src/mcp/resources/index.js'
import type { MCPDependencies } from '../../src/mcp/server.js'
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
    repos: [{ repo: 'org/repo', forge: 'github' as const, localPath: '/tmp/repo', baseBranch: 'main', branchPrefix: 'orch', labels: { ready: ['no:ready'], running: 'no:running', blocked: ['no:blocked', 'no:needs-human'], reviewReady: 'no:review-ready', error: 'no:error', retry: 'no:retry' }, defaults: { planner: 'claude' as const, coder: 'claude' as const, reviewer: 'claude' as const, doneMode: 'pr-ready' as const, notifyPriority: 'normal' as const, prMentions: [] }, verify: [], selectors: { includeLabelsAny: ['no:ready'], excludeLabelsAny: [] }, agents: {} }],
  }
}

describe('MCP Resources', () => {
  let tmpDir: string
  let db: Database.Database
  let deps: MCPDependencies

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-mcp-res-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    deps = { db, config: makeMinimalConfig() as MCPDependencies['config'], forgeAdapters: new Map(), poller: null, metrics: null }
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers expected resources', () => {
    const resources = registerResources()
    const uris = resources.map((r) => r.uri)
    expect(uris).toContain('night-orch://status')
    expect(uris).toContain('night-orch://config')
    expect(uris).toContain('night-orch://metrics')
  })

  it('status resource returns valid data', async () => {
    const result = await handleResourceRead('night-orch://status', deps) as { activeRuns: number; repos: string[] }
    expect(result.activeRuns).toBe(0)
    expect(result.repos).toContain('org/repo')
  })

  it('config resource redacts tokens', async () => {
    const result = await handleResourceRead('night-orch://config', deps) as Record<string, unknown>
    expect(result).toHaveProperty('github')
    const github = result['github'] as { tokenEnv: string }
    // Shows env var NAME, not value
    expect(github.tokenEnv).toBe('GITHUB_TOKEN')
  })

  it('config resource does not expose full repo config', async () => {
    const result = await handleResourceRead('night-orch://config', deps) as { repos: Array<Record<string, unknown>> }
    // Repos should be summarized, not full config
    expect(result.repos[0]).toHaveProperty('repo')
    expect(result.repos[0]).toHaveProperty('forge')
    expect(result.repos[0]).not.toHaveProperty('labels')
  })

  it('metrics resource handles disabled metrics', async () => {
    const result = await handleResourceRead('night-orch://metrics', deps) as { enabled: boolean }
    expect(result.enabled).toBe(false)
  })

  it('runs resource returns run data', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({ repo: 'org/repo', issueNumber: 1, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })

    const result = await handleResourceRead(`night-orch://runs/${run.id}`, deps) as { issueNumber: number }
    expect(result.issueNumber).toBe(1)
  })

  it('runs resource throws for unknown ID', async () => {
    await expect(handleResourceRead('night-orch://runs/run-fake', deps)).rejects.toThrow('Run not found')
  })

  it('logs resource returns events', async () => {
    const result = await handleResourceRead('night-orch://logs/run-test', deps) as { runId: string; events: unknown[] }
    expect(result.runId).toBe('run-test')
    expect(result.events).toEqual([])
  })

  it('logs resource tolerates malformed event JSON', async () => {
    db.prepare(
      "INSERT INTO events (run_id, event_type, data, created_at) VALUES ('run-test', 'step', '{bad json', datetime('now'))",
    ).run()
    const result = await handleResourceRead('night-orch://logs/run-test', deps) as {
      events: Array<{ data: unknown }>
    }
    expect(result.events).toHaveLength(1)
    const payload = result.events[0]!.data as { parseError?: string; raw?: string }
    expect(payload.parseError).toContain('Invalid JSON')
    expect(payload.raw).toContain('{bad json')
  })

  it('unknown resource throws', async () => {
    await expect(handleResourceRead('night-orch://unknown', deps)).rejects.toThrow('Unknown resource')
  })
})
