import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMCPServer } from '../../src/mcp/server.js'
import type { MCPDependencies } from '../../src/mcp/server.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

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
    mcp: { enabled: true, transport: 'stdio' as const, authTokenEnv: null },
    repos: [{ repo: 'org/repo', forge: 'github' as const, localPath: '/tmp/repo', baseBranch: 'main', branchPrefix: 'orch', labels: { ready: ['orch:ready'], running: 'orch:running', blocked: ['orch:blocked', 'orch:needs-human'], reviewReady: 'orch:review-ready', error: 'orch:error', retry: 'orch:retry' }, defaults: { planner: 'claude' as const, coder: 'claude' as const, reviewer: 'claude' as const, doneMode: 'pr-ready' as const, notifyPriority: 'normal' as const, prMentions: [] }, verify: [], selectors: { includeLabelsAny: ['orch:ready'], excludeLabelsAny: [] }, agents: {} }],
  }
}

describe('MCP Integration', () => {
  let tmpDir: string
  let db: Database.Database
  let deps: MCPDependencies
  let client: Client

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-mcp-int-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    deps = { db, config: makeMinimalConfig() as MCPDependencies['config'], forgeAdapters: new Map(), poller: null, metrics: null }

    const server = createMCPServer(deps)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    client = new Client({ name: 'test-client', version: '0.1.0' })
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ])
  })

  afterEach(async () => {
    await client.close()
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists all 15 tools', async () => {
    const result = await client.listTools()
    expect(result.tools.length).toBe(15)
    const names = result.tools.map((t) => t.name)
    expect(names).toContain('night-orch-status')
    expect(names).toContain('night-orch-poll')
    expect(names).toContain('night-orch-list-issues')
    expect(names).toContain('night-orch-stream-events')
    expect(names).toContain('night-orch-rebase')
    expect(names).toContain('night-orch-continue')
    expect(names).toContain('night-orch-delete-entry')
    expect(names).toContain('night-orch-labels-init')
  })

  it('calls status tool and gets valid response', async () => {
    const result = await client.callTool({ name: 'night-orch-status', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
    expect(text).toBeDefined()
    const parsed = JSON.parse(text!)
    expect(parsed.activeRuns).toBe(0)
    expect(parsed.configuredRepos).toContain('org/repo')
  })

  it('calls run-detail tool and returns run info', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({ repo: 'org/repo', issueNumber: 10, issueNodeId: '', planner: 'claude', coder: 'claude', reviewer: 'claude' })

    const result = await client.callTool({ name: 'night-orch-run-detail', arguments: { runId: run.id } })
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
    const parsed = JSON.parse(text!)
    expect(parsed.issueNumber).toBe(10)
  })

  it('returns error for unknown run', async () => {
    const result = await client.callTool({ name: 'night-orch-run-detail', arguments: { runId: 'run-missing' } })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
    expect(text).toContain('Run not found')
  })

  it('lists resources', async () => {
    const result = await client.listResources()
    const uris = result.resources.map((r) => r.uri)
    expect(uris).toContain('night-orch://status')
    expect(uris).toContain('night-orch://config')
    expect(uris).toContain('night-orch://metrics')
  })

  it('reads status resource via protocol', async () => {
    const result = await client.readResource({ uri: 'night-orch://status' })
    const text = (result.contents[0] as { text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed.activeRuns).toBe(0)
    expect(parsed.repos).toContain('org/repo')
  })

  it('reads config resource with redacted tokens', async () => {
    const result = await client.readResource({ uri: 'night-orch://config' })
    const text = (result.contents[0] as { text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed.github.tokenEnv).toBe('GITHUB_TOKEN')
    // Repos should be summarized — no labels or sensitive config
    expect(parsed.repos[0]).not.toHaveProperty('labels')
  })

  it('handles concurrent tool calls', async () => {
    const [status, listRuns, costReport] = await Promise.all([
      client.callTool({ name: 'night-orch-status', arguments: {} }),
      client.callTool({ name: 'night-orch-list-runs', arguments: {} }),
      client.callTool({ name: 'night-orch-cost-report', arguments: { days: 3 } }),
    ])

    expect(status.isError).toBeFalsy()
    expect(listRuns.isError).toBeFalsy()
    expect(costReport.isError).toBeFalsy()
  })

  it('rejects invalid tool input gracefully', async () => {
    const result = await client.callTool({ name: 'night-orch-run-detail', arguments: {} })
    // Missing required runId — should get an error response, not a crash
    expect(result.isError).toBe(true)
  })
})
