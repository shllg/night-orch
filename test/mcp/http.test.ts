import { describe, it, expect, afterEach } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../../src/state/db.js'
import { startMCPHttpServer } from '../../src/mcp/http.js'
import type { MCPDependencies } from '../../src/mcp/server.js'

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
    mcp: { enabled: true, transport: 'stdio' as const, authTokenEnv: null, httpHost: '127.0.0.1', httpPort: 0 },
    repos: [{
      repo: 'org/repo',
      forge: 'github' as const,
      localPath: '/tmp/repo',
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: {
        ready: ['orch:ready'],
        running: 'orch:running',
        blocked: ['orch:blocked', 'orch:needs-human'],
        reviewReady: 'orch:review-ready',
        error: 'orch:error',
        retry: 'orch:retry',
      },
      defaults: { planner: 'claude' as const, coder: 'claude' as const, reviewer: 'claude' as const, doneMode: 'pr-ready' as const, notifyPriority: 'normal' as const, prMentions: [] },
      verify: [],
      selectors: { includeLabelsAny: ['orch:ready'], excludeLabelsAny: [] },
      agents: {},
    }],
  }
}

describe('startMCPHttpServer', () => {
  let tmpDir: string | null = null
  let server: Server | null = null

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  it('rejects non-loopback hosts', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-mcp-http-test-'))
    const db = initDatabase(join(tmpDir, 'test.db'))
    const deps: MCPDependencies = {
      db,
      config: makeMinimalConfig() as MCPDependencies['config'],
      forgeAdapters: new Map(),
      poller: null,
      metrics: null,
    }

    await expect(startMCPHttpServer(deps, '0.0.0.0', 0))
      .rejects
      .toThrow('must bind to a loopback host')
    db.close()
  })

  it('starts on loopback hosts', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-mcp-http-test-'))
    const db = initDatabase(join(tmpDir, 'test.db'))
    const deps: MCPDependencies = {
      db,
      config: makeMinimalConfig() as MCPDependencies['config'],
      forgeAdapters: new Map(),
      poller: null,
      metrics: null,
    }

    server = await startMCPHttpServer(deps, '127.0.0.1', 0)
    expect(server.listening).toBe(true)
    db.close()
  })
})
