import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { request as httpRequest, type OutgoingHttpHeaders, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { startWebServer } from '../../src/web/server.js'
import type { MCPDependencies } from '../../src/mcp/server.js'
import type Database from 'better-sqlite3'
import type { TuiStatsSnapshot } from '../../src/state/stats.js'
import { makeTestConfig } from '../helpers/factories.js'

const MUTATION_INTENT_HEADER = 'x-night-orch-intent'
const WEB_AUTH_TOKEN_HEADER = 'x-night-orch-web-token'
const originalRuntimeDir = process.env['XDG_RUNTIME_DIR']

describe('startWebServer', () => {
  let tmpDir: string
  let frontendDir: string
  let db: Database.Database
  let server: Server | null = null
  let baseUrl = ''
  let deps: MCPDependencies

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-web-test-'))
    frontendDir = join(tmpDir, 'frontend')
    mkdirSync(frontendDir, { recursive: true })
    mkdirSync(join(tmpDir, 'runtime'), { recursive: true })
    writeFileSync(join(frontendDir, 'index.html'), '<!doctype html><html><body>ok</body></html>')
    process.env['XDG_RUNTIME_DIR'] = join(tmpDir, 'runtime')

    db = initDatabase(join(tmpDir, 'test.db'))
    deps = {
      db,
      config: makeTestConfig(),
      forgeAdapters: new Map(),
      poller: null,
      metrics: null,
    }
    deps.config.storage.worktreeRoot = tmpDir
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = null
    }
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
    if (originalRuntimeDir === undefined) {
      delete process.env['XDG_RUNTIME_DIR']
    } else {
      process.env['XDG_RUNTIME_DIR'] = originalRuntimeDir
    }
  })

  async function startTestServer(
    options: Partial<Parameters<typeof startWebServer>[1]> = {},
  ): Promise<string> {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        ...options,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
    return baseUrl
  }

  it('serves API + static frontend', async () => {
    const triggerPollCycle = vi.fn().mockReturnValue({
      accepted: true as const,
      state: 'woke-sleeper' as const,
    })
    deps.poller = { triggerPollCycle }

    await startTestServer({ snapshotIntervalMs: 50 })

    const health = await fetch(`${baseUrl}/api/health`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({ status: 'ok' })
    const mutationToken = await getMutationToken(baseUrl)

    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({}),
    })
    expect(poll.status).toBe(200)
    const pollPayload = await poll.json() as { queued: boolean; state: string }
    expect(pollPayload.queued).toBe(true)
    expect(pollPayload.state).toBe('woke-sleeper')
    expect(triggerPollCycle).toHaveBeenCalledTimes(1)

    const deleteEntry = await fetch(`${baseUrl}/api/operations/delete-entry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({ repo: 'org/repo', issueNumber: 999 }),
    })
    expect(deleteEntry.status).toBe(200)
    await expect(deleteEntry.json()).resolves.toMatchObject({ found: false })

    const index = await fetch(`${baseUrl}/`)
    expect(index.status).toBe(200)
    await expect(index.text()).resolves.toContain('<!doctype html>')
  })

  it('exposes /healthz with metrics readiness details', async () => {
    await startTestServer()

    const healthz = await fetch(`${baseUrl}/healthz`)
    expect(healthz.status).toBe(200)
    await expect(healthz.json()).resolves.toMatchObject({
      ok: true,
      metrics: {
        enabled: false,
        ready: false,
        endpoint: null,
      },
    })
  })

  it('reads and mutates runtime settings through web APIs', async () => {
    await startTestServer({
      rawConfig: {
        github: {
          pollIntervalSeconds: 300,
        },
      },
    })
    const mutationToken = await getMutationToken(baseUrl)

    const initial = await fetch(`${baseUrl}/api/settings`)
    expect(initial.status).toBe(200)
    const initialPayload = await initial.json() as {
      settings: Array<{
        key: string
        source: string
        effectiveValue: number | boolean | string | null
        defaultValue: number | boolean | string | null
        hasYamlValue: boolean
        yamlValue: number | boolean | string | null
      }>
    }
    const pollBefore = initialPayload.settings.find((setting) => setting.key === 'github.pollIntervalSeconds')
    expect(pollBefore?.source).toBe('base')
    expect(pollBefore?.effectiveValue).toBe(300)
    expect(pollBefore?.defaultValue).toBe(300)
    expect(pollBefore?.hasYamlValue).toBe(true)
    expect(pollBefore?.yamlValue).toBe(300)

    const maxReviewBefore = initialPayload.settings.find((setting) => setting.key === 'loop.maxReviewIterations')
    expect(maxReviewBefore?.hasYamlValue).toBe(false)
    expect(maxReviewBefore?.yamlValue).toBeNull()

    const setResponse = await fetch(`${baseUrl}/api/operations/settings/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({
        key: 'github.pollIntervalSeconds',
        value: '120',
      }),
    })
    expect(setResponse.status).toBe(200)
    await expect(setResponse.json()).resolves.toMatchObject({
      changed: true,
      setting: {
        key: 'github.pollIntervalSeconds',
        effectiveValue: 120,
        source: 'override',
      },
    })

    const afterSet = await fetch(`${baseUrl}/api/settings`)
    const afterSetPayload = await afterSet.json() as {
      settings: Array<{ key: string; source: string; effectiveValue: number | boolean | string | null }>
    }
    const pollAfterSet = afterSetPayload.settings.find((setting) => setting.key === 'github.pollIntervalSeconds')
    expect(pollAfterSet?.source).toBe('override')
    expect(pollAfterSet?.effectiveValue).toBe(120)

    const clearResponse = await fetch(`${baseUrl}/api/operations/settings/clear`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({
        key: 'github.pollIntervalSeconds',
      }),
    })
    expect(clearResponse.status).toBe(200)
    await expect(clearResponse.json()).resolves.toMatchObject({
      changed: true,
      setting: {
        key: 'github.pollIntervalSeconds',
        effectiveValue: 300,
        source: 'base',
      },
    })
  })

  it('redacts sensitive worker profile env values in /api/settings', async () => {
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

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        rawConfig: {
          workerProfiles: {
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
          },
        },
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const response = await fetch(`${baseUrl}/api/settings`)
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      settings: Array<{
        key: string
        hasYamlValue: boolean
        yamlValue: unknown
        baseValue: unknown
        effectiveValue: unknown
      }>
    }

    const workerProfiles = payload.settings.find((setting) => setting.key === 'workerProfiles')
    expect(workerProfiles?.hasYamlValue).toBe(true)
    expect(workerProfiles?.baseValue).toMatchObject({
      codexCli: {
        env: {
          OPENAI_API_KEY: '[redacted]',
          MODE: '[redacted]',
        },
      },
    })
    expect(workerProfiles?.effectiveValue).toMatchObject({
      codexCli: {
        env: {
          OPENAI_API_KEY: '[redacted]',
          MODE: '[redacted]',
        },
      },
    })
    expect(workerProfiles?.yamlValue).toMatchObject({
      codexCli: {
        env: {
          OPENAI_API_KEY: '[redacted]',
          MODE: '[redacted]',
        },
      },
    })
  })

  it('keeps yaml presence for schema-valid values outside runtime override bounds', async () => {
    deps.config = makeTestConfig({
      github: {
        pollIntervalSeconds: 7200,
      },
    })

    await startTestServer({
      rawConfig: {
        github: {
          pollIntervalSeconds: 7200,
        },
      },
    })

    const response = await fetch(`${baseUrl}/api/settings`)
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      settings: Array<{
        key: string
        baseValue: number | boolean | string | null
        effectiveValue: number | boolean | string | null
        defaultValue: number | boolean | string | null
        hasYamlValue: boolean
        yamlValue: number | boolean | string | null
      }>
    }

    const pollSetting = payload.settings.find((setting) => setting.key === 'github.pollIntervalSeconds')
    expect(pollSetting).toMatchObject({
      baseValue: 7200,
      effectiveValue: 7200,
      defaultValue: 300,
      hasYamlValue: true,
      yamlValue: 7200,
    })
  })

  it('returns 400 for invalid runtime settings mutations', async () => {
    await startTestServer()
    const mutationToken = await getMutationToken(baseUrl)

    const invalidKeySet = await fetch(`${baseUrl}/api/operations/settings/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({
        key: 'github.notASetting',
        value: '120',
      }),
    })
    expect(invalidKeySet.status).toBe(400)
    await expect(invalidKeySet.json()).resolves.toMatchObject({
      error: expect.stringContaining('Unknown setting key'),
    })

    const invalidValueSet = await fetch(`${baseUrl}/api/operations/settings/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({
        key: 'github.pollIntervalSeconds',
        value: '120abc',
      }),
    })
    expect(invalidValueSet.status).toBe(400)
    await expect(invalidValueSet.json()).resolves.toMatchObject({
      error: 'github.pollIntervalSeconds must be a finite number',
    })

    const invalidJsonStructure = await fetch(`${baseUrl}/api/operations/settings/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({
        key: 'notifications.channels',
        value: '{}',
      }),
    })
    expect(invalidJsonStructure.status).toBe(400)
    await expect(invalidJsonStructure.json()).resolves.toMatchObject({
      error: expect.stringContaining('notifications.channels has invalid structure'),
    })

    const readOnlySet = await fetch(`${baseUrl}/api/operations/settings/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({
        key: 'storage.dbPath',
        value: '/tmp/other.db',
      }),
    })
    expect(readOnlySet.status).toBe(400)
    await expect(readOnlySet.json()).resolves.toMatchObject({
      error: 'storage.dbPath is read-only at runtime and cannot be overridden',
    })

    const invalidKeyClear = await fetch(`${baseUrl}/api/operations/settings/clear`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({
        key: 'github.notASetting',
      }),
    })
    expect(invalidKeyClear.status).toBe(400)
    await expect(invalidKeyClear.json()).resolves.toMatchObject({
      error: expect.stringContaining('Unknown setting key'),
    })
  })

  it('raises, reports, and clears the daily cost cap override via web APIs', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
    const mutationToken = await getMutationToken(baseUrl)

    // Baseline dashboard: override is null, effective == base.
    const before = await fetch(`${baseUrl}/api/dashboard`)
    const beforePayload = await before.json() as {
      cost: { dailyBudgetUsd: number; dailyBudgetOverrideUsd: number | null; effectiveDailyBudgetUsd: number }
    }
    expect(beforePayload.cost.dailyBudgetUsd).toBe(50)
    expect(beforePayload.cost.dailyBudgetOverrideUsd).toBeNull()
    expect(beforePayload.cost.effectiveDailyBudgetUsd).toBe(50)

    // Raise today's cap.
    const setResponse = await fetch(`${baseUrl}/api/operations/daily-cost-override/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({ amountUsd: 250 }),
    })
    expect(setResponse.status).toBe(200)
    await expect(setResponse.json()).resolves.toMatchObject({
      success: true,
      overrideUsd: 250,
      previousUsd: null,
    })

    // Dashboard now reports the override.
    const after = await fetch(`${baseUrl}/api/dashboard`)
    const afterPayload = await after.json() as {
      cost: { dailyBudgetOverrideUsd: number | null; effectiveDailyBudgetUsd: number }
    }
    expect(afterPayload.cost.dailyBudgetOverrideUsd).toBe(250)
    expect(afterPayload.cost.effectiveDailyBudgetUsd).toBe(250)

    // Clear the override.
    const clearResponse = await fetch(`${baseUrl}/api/operations/daily-cost-override/clear`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({}),
    })
    expect(clearResponse.status).toBe(200)
    await expect(clearResponse.json()).resolves.toMatchObject({
      success: true,
      overrideUsd: null,
      previousUsd: 250,
    })

    const finalDashboard = await fetch(`${baseUrl}/api/dashboard`)
    const finalPayload = await finalDashboard.json() as {
      cost: { dailyBudgetOverrideUsd: number | null; effectiveDailyBudgetUsd: number }
    }
    expect(finalPayload.cost.dailyBudgetOverrideUsd).toBeNull()
    expect(finalPayload.cost.effectiveDailyBudgetUsd).toBe(50)
  })

  it('rejects invalid daily cost override amounts', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
    const mutationToken = await getMutationToken(baseUrl)

    const invalid = await fetch(`${baseUrl}/api/operations/daily-cost-override/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({ amountUsd: -10 }),
    })
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({
      error: expect.stringContaining('positive finite'),
    })
  })

  it('sets and clears a per-issue cost override via web APIs', async () => {
    const runManager = new RunManager(db)
    runManager.create({
      repo: 'org/repo',
      issueNumber: 77,
      issueNodeId: 'node-77',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
    const mutationToken = await getMutationToken(baseUrl)

    const setResponse = await fetch(`${baseUrl}/api/operations/cost-override/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({ repo: 'org/repo', issueNumber: 77, amountUsd: 42 }),
    })
    expect(setResponse.status).toBe(200)
    await expect(setResponse.json()).resolves.toMatchObject({
      success: true,
      overrideUsd: 42,
    })

    const clearResponse = await fetch(`${baseUrl}/api/operations/cost-override/clear`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({ repo: 'org/repo', issueNumber: 77 }),
    })
    expect(clearResponse.status).toBe(200)
    await expect(clearResponse.json()).resolves.toMatchObject({
      success: true,
      overrideUsd: null,
      previousOverrideUsd: 42,
    })
  })

  it('dashboard includes tracked issues that do not have run rows yet', async () => {
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

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const dashboard = await fetch(`${baseUrl}/api/dashboard`)
    expect(dashboard.status).toBe(200)
    const payload = await dashboard.json() as {
      build: { version: string; gitSha: string | null }
      runs: { runs: Array<{ issue: number; status: string; runId: string; hasRun: boolean }> }
    }
    const trackedIssue = payload.runs.runs.find((run) => run.issue === 58)

    expect(payload.build.version).toMatch(/\S+/)
    if (payload.build.gitSha !== null) {
      expect(payload.build.gitSha).toMatch(/^[0-9a-f]{7,40}$/)
    }
    expect(trackedIssue).toBeDefined()
    expect(trackedIssue?.status).toBe('queued')
    expect(trackedIssue?.hasRun).toBe(false)
    expect(trackedIssue?.runId.startsWith('issue:')).toBe(true)
  })

  it('supports run history browsing with view filters and pagination on /api/runs', async () => {
    const runManager = new RunManager(db)
    const completed = runManager.create({
      repo: 'org/repo',
      issueNumber: 71,
      issueNodeId: 'node-71',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(completed.id, {
      status: 'completed',
      endedAt: '2026-04-05T10:00:00.000Z',
    })

    const errored = runManager.create({
      repo: 'org/repo',
      issueNumber: 72,
      issueNodeId: 'node-72',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(errored.id, {
      status: 'error',
      endedAt: '2026-04-05T10:05:00.000Z',
    })

    const blocked = runManager.create({
      repo: 'org/repo',
      issueNumber: 73,
      issueNodeId: 'node-73',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(blocked.id, {
      status: 'blocked',
      endedAt: '2026-04-05T10:10:00.000Z',
    })

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const failedPageOne = await fetch(`${baseUrl}/api/runs?repo=org%2Frepo&view=failed&limit=1&offset=0`)
    expect(failedPageOne.status).toBe(200)
    const failedPageOnePayload = await failedPageOne.json() as {
      count: number
      hasMore: boolean
      nextOffset: number | null
      runs: Array<{ runId: string; status: string }>
    }
    expect(failedPageOnePayload.count).toBe(1)
    expect(failedPageOnePayload.hasMore).toBe(true)
    expect(failedPageOnePayload.nextOffset).toBe(1)
    expect(failedPageOnePayload.runs[0]?.status).toBe('blocked')

    const failedPageTwo = await fetch(`${baseUrl}/api/runs?repo=org%2Frepo&view=failed&limit=1&offset=1`)
    expect(failedPageTwo.status).toBe(200)
    const failedPageTwoPayload = await failedPageTwo.json() as {
      count: number
      hasMore: boolean
      nextOffset: number | null
      runs: Array<{ runId: string; status: string }>
    }
    expect(failedPageTwoPayload.count).toBe(1)
    expect(failedPageTwoPayload.hasMore).toBe(false)
    expect(failedPageTwoPayload.nextOffset).toBeNull()
    expect(failedPageTwoPayload.runs[0]?.status).toBe('error')

    const allRuns = await fetch(`${baseUrl}/api/runs?repo=org%2Frepo&view=all&limit=10&offset=0`)
    expect(allRuns.status).toBe(200)
    const allRunsPayload = await allRuns.json() as {
      runs: Array<{ runId: string }>
    }
    expect(allRunsPayload.runs.map((run) => run.runId)).toContain(completed.id)
    expect(allRunsPayload.runs.map((run) => run.runId)).toContain(errored.id)
    expect(allRunsPayload.runs.map((run) => run.runId)).toContain(blocked.id)
  })

  it('exposes operator inbox triage on /api/inbox and dashboard snapshot', async () => {
    const runManager = new RunManager(db)

    const reviewReady = runManager.create({
      repo: 'org/repo',
      issueNumber: 81,
      issueNodeId: 'node-81',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(reviewReady.id, {
      status: 'review_ready',
      prNumber: 381,
      endedAt: '2026-04-06T10:00:00.000Z',
    })

    const needsHuman = runManager.create({
      repo: 'org/repo',
      issueNumber: 82,
      issueNodeId: 'node-82',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runManager.update(needsHuman.id, {
      status: 'blocked',
      blockReason: 'reviewer_blocked',
      endedAt: '2026-04-06T10:05:00.000Z',
    })

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const inboxResponse = await fetch(`${baseUrl}/api/inbox?repo=org%2Frepo&limit=20&offset=0`)
    expect(inboxResponse.status).toBe(200)
    const inboxPayload = await inboxResponse.json() as {
      count: number
      triageCounts: Record<string, number>
      items: Array<{ runId: string; triage: string; status: string }>
    }
    expect(inboxPayload.count).toBe(2)
    expect(inboxPayload.triageCounts).toMatchObject({
      needs_human: 1,
      review_ready: 1,
    })
    expect(inboxPayload.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: reviewReady.id,
          triage: 'review_ready',
          status: 'review_ready',
        }),
        expect.objectContaining({
          runId: needsHuman.id,
          triage: 'needs_human',
          status: 'blocked',
        }),
      ]),
    )

    const dashboard = await fetch(`${baseUrl}/api/dashboard`)
    expect(dashboard.status).toBe(200)
    const dashboardPayload = await dashboard.json() as {
      inbox: {
        triageCounts: Record<string, number>
      }
    }
    expect(dashboardPayload.inbox.triageCounts).toMatchObject({
      needs_human: 1,
      review_ready: 1,
    })
  })

  it('dashboard includes full stats snapshot fields for the web stats page', async () => {
    await startTestServer()

    const dashboard = await fetch(`${baseUrl}/api/dashboard`)
    expect(dashboard.status).toBe(200)
    const payload = await dashboard.json() as { stats: TuiStatsSnapshot }

    expect(typeof payload.stats.updatedAt).toBe('string')
    expectNumericStats(payload.stats.overview, [
      'totalRuns', 'activeRuns', 'queuedRuns', 'runningRuns',
      'reviewReadyRuns', 'completedRuns', 'blockedRuns', 'errorRuns',
    ])
    expectNumericStats(payload.stats.throughput, [
      'runs24h', 'runs7d', 'runs30d', 'completed7d', 'blocked7d', 'error7d',
      'successRate7d', 'avgDurationMinutes7d', 'avgIterations7d',
    ])
    expectNumericStats(payload.stats.reliability, ['failureCount7d', 'failureRate7d'])
    expectNumericStats(payload.stats.cost, ['todayCostUsd', 'todayTheoreticalCostUsd', 'todayRunCount', 'cost7d', 'theoretical7d', 'cost30d', 'theoretical30d', 'avgDailyCost7d'])
    expectNumericStats(payload.stats.efficiency, [
      'totalCostUsd7d', 'avgCostPerRun7d', 'avgCostPerSuccess7d',
      'avgCostPerIteration7d', 'completedPerDollar7d',
      'avgTokensPerRun7d', 'avgTokensPerSuccess7d', 'avgTokensPerIteration7d',
    ])
    expectNumericStats(payload.stats.resources, [
      'activeLeases', 'expiringLeases', 'expiredLeases', 'leasedRepos',
      'activeWorktrees', 'missingWorktrees', 'staleWorktrees',
    ])
    expectNumericStats(payload.stats.timing, ['sampleSize30d', 'p50Minutes', 'p90Minutes', 'p99Minutes'])
    expectNumericStats(payload.stats.queue, ['activeBatches'])
    expectNumericStats(payload.stats.agents, [
      'eventsTotal', 'events24h', 'events7d', 'toolCalls24h', 'thinking24h', 'uniqueRuns7d',
    ])
    expect(Array.isArray(payload.stats.statusCounts)).toBe(true)
    expect(Array.isArray(payload.stats.phaseCounts)).toBe(true)
    expect(Array.isArray(payload.stats.reliability.topErrorPatterns7d)).toBe(true)
    expect(Array.isArray(payload.stats.cost.dailyHistory)).toBe(true)
    expect(Array.isArray(payload.stats.queue.statuses)).toBe(true)
    expect(Array.isArray(payload.stats.agents.roleBreakdown7d)).toBe(true)
    expect(Array.isArray(payload.stats.topRepos30d)).toBe(true)
  })

  it('reports interactive agent workspace path from configured storage root', async () => {
    deps.config.storage.worktreeRoot = './tmp/worktrees-relative'

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const response = await fetch(`${baseUrl}/api/agent/sessions`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { workspacePath: string }
    expect(payload.workspacePath).toBe(resolve('./tmp/worktrees-relative'))
  })

  it('returns projects config snapshot for the web projects page', async () => {
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

    deps.config.repos[0] = {
      ...deps.config.repos[0],
      tokenEnv: 'CUSTOM_GH_TOKEN',
      apiBaseUrl: 'https://api.github.acme',
      agents: {
        codex: 'codexCli',
      },
      verify: [
        'pnpm lint',
        ['pnpm', 'test'],
        {
          command: ['bundle', 'exec', 'rails', 'test'],
          env: { RAILS_ENV: 'test', DB_PASSWORD: 'super-secret-local-pw' },
          before: [['docker', 'compose', 'up']],
        },
      ],
      prompts: {
        plannerSystem: 'planner custom prompt',
      },
      environment: {
        ports: { postgres: { min: 5400, max: 5499 }, redis: { min: 6400, max: 6499 } },
        beforeRun: [{
          command: ['pnpm', 'install'],
          failureHints: [{
            contains: 'not found',
            message: 'Install dependencies first.',
            output: 'stderr' as const,
          }],
        }],
        afterRun: [{ command: 'pnpm clean' }],
      },
    }

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const projects = await fetch(`${baseUrl}/api/projects`)
    expect(projects.status).toBe(200)

    const payload = await projects.json() as {
      githubDefaults: { tokenEnv: string; apiBaseUrl: string }
      workerProfiles: Record<string, { envKeys: string[]; env?: unknown }>
      repos: Array<{
        repo: string
        labels: { blocked: string }
        prompts: { plannerSystem: boolean; coderSystem: boolean; reviewerSystem: boolean }
        environment?: {
          ports?: Record<string, { min: number; max: number }>
          beforeRun?: Array<string | string[] | {
            command: string | string[]
            failureHints?: Array<{
              contains: string
              message: string
              output: string
            }>
          }>
          afterRun?: Array<string | string[] | { command: string | string[] }>
        }
        verify?: Array<string | string[] | { command: unknown; envKeys?: string[]; env?: unknown }>
      }>
    }

    expect(payload.githubDefaults).toMatchObject({
      tokenEnv: 'GITHUB_TOKEN',
      apiBaseUrl: 'https://api.github.com',
    })
    expect(payload.workerProfiles['codexCli']).toBeDefined()
    expect(payload.workerProfiles['codexCli']?.envKeys).toEqual(['OPENAI_API_KEY', 'MODE'])
    expect(payload.workerProfiles['codexCli']).not.toHaveProperty('env')

    expect(payload.repos).toHaveLength(1)
    expect(payload.repos[0]?.repo).toBe('org/repo')
    expect(payload.repos[0]?.labels.blocked).toBe('no:blocked')
    expect(payload.repos[0]?.prompts).toMatchObject({
      plannerSystem: true,
      coderSystem: false,
      reviewerSystem: false,
    })
    const beforeHook = payload.repos[0]?.environment?.beforeRun?.[0]
    const hints = beforeHook && typeof beforeHook === 'object' && 'failureHints' in beforeHook
      ? beforeHook.failureHints
      : undefined
    expect(hints?.[0]).toMatchObject({
      contains: 'not found',
      message: 'Install dependencies first.',
      output: 'stderr',
    })
    expect(payload.repos[0]?.environment?.ports).toEqual({
      postgres: { min: 5400, max: 5499 },
      redis: { min: 6400, max: 6499 },
    })

    // Verify command env is redacted to KEYS ONLY — values (DB passwords) must
    // never appear in the projects API response.
    const rawBody = JSON.stringify(payload)
    expect(rawBody).not.toContain('super-secret-local-pw')
    const railsCmd = payload.repos[0]?.verify?.find(
      (c): c is { command: unknown; envKeys?: string[]; env?: unknown } =>
        typeof c === 'object' && !Array.isArray(c) && 'envKeys' in c,
    )
    expect(railsCmd?.envKeys).toEqual(['RAILS_ENV', 'DB_PASSWORD'])
    expect(railsCmd).not.toHaveProperty('env')
  })

  it('rejects mutating API requests without explicit mutation intent header', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(poll.status).toBe(403)
    await expect(poll.json()).resolves.toMatchObject({
      error: 'Missing required header: x-night-orch-intent',
    })
  })

  it('disables web operations when operationsEnabled is false', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        operationsEnabled: false,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const session = await fetch(`${baseUrl}/api/session`)
    expect(session.status).toBe(200)
    await expect(session.json()).resolves.toMatchObject({ operationsEnabled: false })

    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(poll.status).toBe(409)
    await expect(poll.json()).resolves.toMatchObject({
      error: 'Web operations are disabled by server policy.',
    })

    const agentCreate = await fetch(`${baseUrl}/api/agent/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'claude' }),
    })
    expect(agentCreate.status).toBe(409)
    await expect(agentCreate.json()).resolves.toMatchObject({
      error: 'Web operations are disabled by server policy.',
    })

  })

  it('requires application/json for mutating API requests', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        [MUTATION_INTENT_HEADER]: 'mutate',
      },
      body: '{}',
    })

    expect(poll.status).toBe(415)
    await expect(poll.json()).resolves.toMatchObject({
      error: 'Content-Type must be application/json',
    })
  })

  it('rejects forged Host/Origin pairs even when they match each other', async () => {
    const triggerPollCycle = vi.fn().mockReturnValue({
      accepted: true as const,
      state: 'woke-sleeper' as const,
    })
    deps.poller = { triggerPollCycle }

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }

    baseUrl = `http://127.0.0.1:${address.port}`
    const mutationToken = await getMutationToken(baseUrl)

    const forged = await sendRawHttpRequest(address.port, '/api/operations/poll', {
      method: 'POST',
      headers: {
        Host: `evil.test:${address.port}`,
        Origin: `http://evil.test:${address.port}`,
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: '{}',
    })

    expect(forged.statusCode).toBe(403)
    expect(JSON.parse(forged.body) as { error: string }).toMatchObject({ error: 'Forbidden host' })
    expect(triggerPollCycle).toHaveBeenCalledTimes(0)

    const forgedWs = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: `http://evil.test:${address.port}`,
      headers: { Host: `evil.test:${address.port}` },
    })

    const [errorPayload] = await once(forgedWs, 'error')
    expect(errorPayload).toBeInstanceOf(Error)
    const error = errorPayload as Error
    expect(error.message).toContain('Unexpected server response: 403')
  })

  it('enforces web mutation auth token and succeeds with a valid token when MCP auth is enabled', async () => {
    const triggerPollCycle = vi.fn().mockReturnValue({
      accepted: true as const,
      state: 'woke-sleeper' as const,
    })
    deps.poller = { triggerPollCycle }
    deps.config.mcp.authTokenEnv = 'NIGHT_ORCH_TEST_MCP_TOKEN'

    const previousToken = process.env['NIGHT_ORCH_TEST_MCP_TOKEN']
    process.env['NIGHT_ORCH_TEST_MCP_TOKEN'] = 'test-mcp-token'

    try {
      server = await startWebServer(
        deps,
        {
          host: '127.0.0.1',
          port: 0,
          frontendDistPath: frontendDir,
        },
      )

      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Unexpected address type')
      }

      baseUrl = `http://127.0.0.1:${address.port}`
      const mutationToken = await getMutationToken(baseUrl)

      const missingToken = await fetch(`${baseUrl}/api/operations/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: 'mutate',
        },
        body: '{}',
      })
      expect(missingToken.status).toBe(401)
      // Phase 2a: error now mentions both the cookie and the header
      // fallback so operators see the cookie auth option.
      await expect(missingToken.json()).resolves.toMatchObject({
        error: `Missing session cookie or required header: ${WEB_AUTH_TOKEN_HEADER}`,
      })

      const invalidToken = await fetch(`${baseUrl}/api/operations/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: 'mutate',
          [WEB_AUTH_TOKEN_HEADER]: 'invalid-token',
        },
        body: '{}',
      })
      expect(invalidToken.status).toBe(403)
      await expect(invalidToken.json()).resolves.toMatchObject({
        error: 'Invalid web auth token',
      })

      const validToken = await fetch(`${baseUrl}/api/operations/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: 'mutate',
          [WEB_AUTH_TOKEN_HEADER]: mutationToken,
        },
        body: '{}',
      })
      expect(validToken.status).toBe(200)
      await expect(validToken.json()).resolves.toMatchObject({
        queued: true,
      })
      expect(triggerPollCycle).toHaveBeenCalledTimes(1)
    } finally {
      if (previousToken === undefined) {
        delete process.env['NIGHT_ORCH_TEST_MCP_TOKEN']
      } else {
        process.env['NIGHT_ORCH_TEST_MCP_TOKEN'] = previousToken
      }
    }
  })

  it('Phase 2a — POST /api/auth/session sets a cookie that authorizes subsequent mutations', async () => {
    const triggerPollCycle = vi.fn().mockReturnValue({
      accepted: true as const,
      state: 'woke-sleeper' as const,
    })
    deps.poller = { triggerPollCycle }

    await startTestServer()
    const mutationToken = await getMutationToken(baseUrl)

    // GET /api/auth/session → authenticated:false before login.
    const preLogin = await fetch(`${baseUrl}/api/auth/session`)
    expect(preLogin.status).toBe(200)
    await expect(preLogin.json()).resolves.toMatchObject({ authenticated: false })

    // Invalid token → 401.
    const badLogin = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
      },
      body: JSON.stringify({ token: 'not-the-real-token' }),
    })
    expect(badLogin.status).toBe(401)

    // Valid token → 204 + Set-Cookie.
    const login = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
      },
      body: JSON.stringify({ token: mutationToken }),
    })
    expect(login.status).toBe(204)
    const setCookie = login.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    expect(setCookie).toContain('norch_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('norch_csrf=')
    expect(setCookie).toContain('SameSite=Strict')

    // Extract the cookie values so we can present them on the mutation request.
    const cookies = setCookie!.split(/,\s*(?=[^;,]+=)/).map((cookie) => cookie.split(';')[0]!)
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('norch_session='))
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('norch_csrf='))
    expect(sessionCookie).toBeDefined()
    expect(csrfCookie).toBeDefined()
    const csrfToken = csrfCookie!.split('=')[1]!

    // Mutation with the cookie session succeeds when the double-submit
    // CSRF cookie and header match.
    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        'x-csrf-token': csrfToken,
        Cookie: `${sessionCookie}; ${csrfCookie}`,
      },
      body: '{}',
    })
    expect(poll.status).toBe(200)
    expect(triggerPollCycle).toHaveBeenCalledTimes(1)
  })

  it('Phase 2a — requireAuth:false bypasses the mutation guard entirely', async () => {
    const triggerPollCycle = vi.fn().mockReturnValue({
      accepted: true as const,
      state: 'woke-sleeper' as const,
    })
    deps.poller = { triggerPollCycle }

    server = await startWebServer(deps, {
      host: '127.0.0.1',
      port: 0,
      frontendDistPath: frontendDir,
      requireAuth: false,
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Unexpected address type')
    baseUrl = `http://127.0.0.1:${address.port}`

    // No cookie, no token header — should still succeed because
    // authRequired:false short-circuits the guard.
    const poll = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
      },
      body: '{}',
    })
    expect(poll.status).toBe(200)
    expect(triggerPollCycle).toHaveBeenCalledTimes(1)
  })

  it('Phase 2a — requireAuth:false still enforces the intent header (CSRF)', async () => {
    server = await startWebServer(deps, {
      host: '127.0.0.1',
      port: 0,
      frontendDistPath: frontendDir,
      requireAuth: false,
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Unexpected address type')
    baseUrl = `http://127.0.0.1:${address.port}`

    // Without the intent header the guard still rejects — this
    // blocks drive-by form submission CSRF even when auth is off.
    const missing = await fetch(`${baseUrl}/api/operations/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(missing.status).toBe(403)
  })

  it('Phase 2a — POST /api/auth/logout clears the session cookie', async () => {
    await startTestServer()

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
      },
    })
    expect(logout.status).toBe(204)
    const setCookie = logout.headers.get('set-cookie')
    expect(setCookie).toContain('norch_session=')
    expect(setCookie).toContain('Max-Age=0')
  })

  it('returns 404 for missing asset files but serves index fallback for extensionless routes', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const missingAsset = await fetch(`${baseUrl}/assets/missing.js`)
    expect(missingAsset.status).toBe(404)

    const clientRoute = await fetch(`${baseUrl}/runs/route-only`)
    expect(clientRoute.status).toBe(200)
    await expect(clientRoute.text()).resolves.toContain('<!doctype html>')
  })

  it('creates interactive agent sessions and streams prompt output over websocket', async () => {
    deps.config.workerProfiles = {
      interactiveClaude: {
        type: 'claude',
        command: 'sh',
        args: [
          '-c',
          'cat >/dev/null; printf \'{"type":"assistant","message":{"content":[{"type":"text","text":"hello from interactive test"}]}}\\n\'',
        ],
        workerTimeoutSeconds: 5,
        minimalEnv: true,
        runtimeWrapper: null,
        env: {},
      },
    }

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        snapshotIntervalMs: 50,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
    const mutationToken = await getMutationToken(baseUrl)

    const create = await fetch(`${baseUrl}/api/agent/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
      body: JSON.stringify({
        agent: 'claude',
        profileName: 'interactiveClaude',
      }),
    })
    expect(create.status).toBe(200)
    const createPayload = await create.json() as {
      session: { id: string; status: string; agent: string }
    }
    const sessionId = createPayload.session.id
    expect(createPayload.session.status).toBe('idle')
    expect(createPayload.session.agent).toBe('claude')

    const wsOrigin = `http://127.0.0.1:${address.port}`
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: wsOrigin })
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'subscribe-agent-session-events', sessionId, since: 0 }))

    try {
      const liveEventsPromise = waitForWsMessage<{
        type: string
        payload: {
          sessionId: string
          events: Array<{
            type: string
            data: { text?: string; message?: string }
          }>
        }
      }>(ws, (payload) => {
        if (!payload || typeof payload !== 'object') return null
        const message = payload as { type?: unknown; payload?: unknown }
        if (message.type !== 'agent-session-events' || !message.payload || typeof message.payload !== 'object') return null
        const body = message.payload as {
          sessionId?: unknown
          events?: unknown
        }
        if (body.sessionId !== sessionId || !Array.isArray(body.events)) return null
        const hasTurnStarted = body.events.some((event) => (
          event
          && typeof event === 'object'
          && (event as { type?: unknown }).type === 'status'
          && ((event as { data?: unknown }).data as { message?: unknown } | undefined)?.message === 'Turn started'
        ))
        if (!hasTurnStarted) return null
        return message as {
          type: string
          payload: {
            sessionId: string
            events: Array<{
              type: string
              data: { text?: string; message?: string }
            }>
          }
        }
      }, 5000)

      const sendPrompt = await fetch(`${baseUrl}/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MUTATION_INTENT_HEADER]: 'mutate',
          [WEB_AUTH_TOKEN_HEADER]: mutationToken,
        },
        body: JSON.stringify({
          prompt: 'say hello',
        }),
      })
      expect(sendPrompt.status).toBe(200)
      await expect(sendPrompt.json()).resolves.toMatchObject({
        accepted: true,
        sessionId,
      })

      const liveEvents = await liveEventsPromise

      expect(liveEvents.payload.events.some((event) =>
        event.type === 'status'
        && event.data.message === 'Turn started')).toBe(true)
    } finally {
      ws.close()
    }

    const eventsPayload = await waitForAgentSessionEvents(
      baseUrl,
      sessionId,
      (payload) => payload.events.some((event) => event.type === 'text'),
      5_000,
    )
    expect(eventsPayload).toMatchObject({
      sessionId,
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
      ]),
    })

    const close = await fetch(`${baseUrl}/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        [MUTATION_INTENT_HEADER]: 'mutate',
        [WEB_AUTH_TOKEN_HEADER]: mutationToken,
      },
    })
    expect(close.status).toBe(200)
    await expect(close.json()).resolves.toMatchObject({
      session: {
        id: sessionId,
        status: 'closed',
      },
    })
  })

  it('returns websocket command validation errors for non-object payloads', async () => {
    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        snapshotIntervalMs: 50,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }

    const wsOrigin = `http://127.0.0.1:${address.port}`
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: wsOrigin })
    await once(ws, 'open')
    ws.send(JSON.stringify('not-an-object'))

    const errorMessage = await waitForWsMessage<{ error: string }>(ws, (payload) => {
      if (!payload || typeof payload !== 'object') return null
      const message = payload as { type?: unknown; error?: unknown }
      if (message.type !== 'error' || typeof message.error !== 'string') return null
      return { error: message.error }
    }, 5000)

    expect(errorMessage.error).toBe('Invalid websocket command payload')
    ws.close()
  })

  it('streams run events over websocket subscriptions', async () => {
    const runManager = new RunManager(db)
    const run = runManager.create({
      repo: 'org/repo',
      issueNumber: 12,
      issueNodeId: 'node-12',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })

    db.prepare(
      `INSERT INTO run_log_events (run_id, source, phase, role, event_type, data, created_at)
       VALUES (?, 'agent', 'code', 'coder', 'text', '{"text":"hello"}', datetime('now'))`,
    ).run(run.id)

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        snapshotIntervalMs: 50,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    const wsOrigin = `http://127.0.0.1:${address.port}`
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: wsOrigin })
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'subscribe-run-events', runId: run.id, since: 0 }))

    const runEvents = await waitForWsMessage<RunEventsPayload>(ws, (payload) => {
      if (!payload || typeof payload !== 'object') return null
      const message = payload as { type?: unknown; payload?: unknown }
      if (message.type !== 'run-events' || !message.payload || typeof message.payload !== 'object') return null
      const body = message.payload as { runId?: unknown; events?: unknown; lastEventId?: unknown }
      if (body.runId !== run.id || !Array.isArray(body.events) || body.events.length === 0) return null
      if (typeof body.lastEventId !== 'number') return null
      return body as RunEventsPayload
    }, 5000)

    expect(runEvents.runId).toBe(run.id)
    expect(runEvents.events[0]?.type).toBe('text')
    ws.close()

    const forbiddenWs = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: 'https://evil.example' })
    const [errorPayload] = await once(forbiddenWs, 'error')
    expect(errorPayload).toBeInstanceOf(Error)
    const error = errorPayload as Error
    expect(error.message).toContain('Unexpected server response: 403')
  })

  it('streams issue-scoped events over websocket subscriptions', async () => {
    const runManager = new RunManager(db)
    const firstRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 21,
      issueNodeId: 'node-21',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    db.prepare(
      `INSERT INTO run_log_events (run_id, source, phase, role, event_type, data, created_at)
       VALUES (?, 'agent', 'code', 'coder', 'text', '{"text":"hello"}', datetime('now'))`,
    ).run(firstRun.id)
    runManager.update(firstRun.id, { status: 'completed', endedAt: '2026-04-12T10:01:00Z' })

    const secondRun = runManager.create({
      repo: 'org/repo',
      issueNumber: 21,
      issueNodeId: 'node-21',
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    db.prepare(
      `INSERT INTO run_log_events (run_id, source, phase, role, event_type, data, created_at)
       VALUES (?, 'user', NULL, 'web', 'user_action', '{"kind":"retry"}', datetime('now'))`,
    ).run(secondRun.id)

    server = await startWebServer(
      deps,
      {
        host: '127.0.0.1',
        port: 0,
        frontendDistPath: frontendDir,
        snapshotIntervalMs: 50,
      },
    )

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address type')
    }

    const wsOrigin = `http://127.0.0.1:${address.port}`
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: wsOrigin })
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'subscribe-issue-events', repo: 'org/repo', issueNumber: 21, since: 0 }))

    const issueEvents = await waitForWsMessage<{
      repo: string
      issueNumber: number
      events: Array<{ runId: string; source: string }>
      lastEventId: number
    }>(ws, (payload) => {
      if (!payload || typeof payload !== 'object') return null
      const message = payload as { type?: unknown; payload?: unknown }
      if (message.type !== 'issue-events' || !message.payload || typeof message.payload !== 'object') return null
      const body = message.payload as {
        repo?: unknown
        issueNumber?: unknown
        events?: unknown
        lastEventId?: unknown
      }
      if (body.repo !== 'org/repo' || body.issueNumber !== 21 || !Array.isArray(body.events) || body.events.length < 2) return null
      if (typeof body.lastEventId !== 'number') return null
      return body as {
        repo: string
        issueNumber: number
        events: Array<{ runId: string; source: string }>
        lastEventId: number
      }
    }, 5000)

    expect(issueEvents.events.map((event) => event.runId)).toEqual([firstRun.id, secondRun.id])
    expect(issueEvents.events.map((event) => event.source)).toEqual(['agent', 'user'])
    ws.close()
  })
})

async function getMutationToken(baseUrl: string): Promise<string> {
  const session = await fetch(`${baseUrl}/api/session`)
  expect(session.status).toBe(200)
  const payload = await session.json() as {
    loopbackTokenHint?: { path?: unknown } | null
  }
  const tokenPath = payload.loopbackTokenHint?.path
  if (typeof tokenPath !== 'string' || tokenPath.length === 0) {
    throw new Error('Missing loopback token sidecar hint in /api/session response')
  }
  return readFileSync(tokenPath, 'utf-8').trim()
}

async function sendRawHttpRequest(
  port: number,
  path: string,
  options: {
    method: string
    headers?: OutgoingHttpHeaders
    body?: string
  },
): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        })
      },
    )

    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

async function waitForWsMessage<T>(
  ws: WebSocket,
  matcher: (payload: unknown) => T | null,
  timeoutMs: number,
): Promise<T> {
  const timeout = new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error('Timed out waiting for websocket message')), timeoutMs)
  })

  const stream = new Promise<T>((resolve) => {
    ws.on('message', (raw) => {
      let parsed: unknown
      try {
        const message = decodeWsRaw(raw)
        if (message === null) return
        parsed = JSON.parse(message) as unknown
      } catch {
        return
      }
      const match = matcher(parsed)
      if (match) {
        resolve(match)
      }
    })
  })

  return Promise.race([timeout, stream])
}

function expectNumericStats<T extends Record<string, unknown>>(
  section: T,
  keys: Array<Extract<keyof T, string>>,
): void {
  const numericKeys = Object.entries(section)
    .filter(([, value]) => typeof value === 'number')
    .map(([key]) => key)
    .sort()
  expect(numericKeys).toEqual([...keys].sort())
  for (const key of keys) {
    expect(typeof section[key]).toBe('number')
  }
}

async function waitForAgentSessionEvents(
  baseUrl: string,
  sessionId: string,
  matcher: (payload: {
    sessionId: string
    status: string
    events: Array<{ type: string }>
    lastEventId: number
  }) => boolean,
  timeoutMs: number,
): Promise<{
  sessionId: string
  status: string
  events: Array<{ type: string }>
  lastEventId: number
}> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(`${baseUrl}/api/agent/sessions/${encodeURIComponent(sessionId)}/events?since=0&limit=400`)
    if (response.status !== 200) {
      throw new Error(`Failed to read session events (${response.status})`)
    }
    const payload = await response.json() as {
      sessionId: string
      status: string
      events: Array<{ type: string }>
      lastEventId: number
    }
    if (matcher(payload)) {
      return payload
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for agent session events')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

function decodeWsRaw(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw instanceof Buffer) return raw.toString('utf-8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf-8')
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf-8')
  }
  return null
}
