import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import type { Config } from '../../src/config/schema.js'
import { initDatabase } from '../../src/state/db.js'
import {
  clearRuntimeSettingOverride,
  listRuntimeSettings,
  resolveConfigWithRuntimeSettings,
  setRuntimeSettingOverride,
} from '../../src/settings/runtime.js'

function makeMinimalConfig(): Config {
  return {
    version: 1,
    github: {
      tokenEnv: 'GITHUB_TOKEN',
      apiBaseUrl: 'https://api.github.com',
      pollIntervalSeconds: 300,
      appMentions: {},
    },
    storage: {
      dbPath: '/tmp/state.db',
      worktreeRoot: '/tmp/worktrees',
      logsRoot: '/tmp/logs',
      autoCleanup: {
        enabled: true,
        intervalMinutes: 60,
      },
      retention: {
        worktreeAgeDays: 7,
        detailDays: 30,
        archiveDays: 90,
      },
    },
    notifications: {
      channels: [{ type: 'console' }],
      events: {
        onRunStarted: false,
        onBlocked: true,
        onPrReady: true,
        onPrUpdated: true,
        onError: true,
        onRetryExhausted: true,
      },
    },
    loop: {
      maxReviewIterations: 4,
      maxTotalAgentPasses: 10,
      stopOnPlannerFailure: true,
      requireVerificationPass: true,
      reviewApprovalKeyword: 'APPROVED',
      reviewNeedsChangesKeyword: 'CHANGES_REQUIRED',
      blockOnAmbiguousReview: true,
      maxAutoRetries: 3,
      decompose: false,
      maxSubtasks: 5,
      maxConcurrentSubtasks: 3,
    },
    security: {
      maxChangedFiles: 50,
      maxChangedLines: 5000,
      maxDailyCostUsd: 50,
      maxCostPerRunUsd: 10,
    },
    workerProfiles: {},
    metrics: {
      enabled: false,
      port: 9090,
      host: '127.0.0.1',
    },
    observability: {
      agentStreaming: true,
      eventRetention: 1000,
      sessionLogs: true,
      sessionLogRetention: 7,
    },
    mcp: {
      enabled: true,
      transport: 'stdio',
      authTokenEnv: null,
      httpHost: '127.0.0.1',
      httpPort: 3100,
    },
    commentCommands: {
      enabled: true,
      requireCollaborator: false,
    },
    repos: [{
      repo: 'org/repo',
      forge: 'github',
      linkedProjects: [],
      localPath: '/tmp/repo',
      maxConcurrentRuns: 1,
      baseBranch: 'main',
      branchPrefix: 'orch',
      labels: {
        ready: ['orch:ready'],
        running: 'orch:running',
        blocked: 'orch:blocked',
        needsHuman: 'orch:needs-human',
        reviewReady: 'orch:review-ready',
        error: 'orch:error',
        retry: 'orch:retry',
        planning: 'orch:planning',
        mergeQueued: 'orch:merge-queued',
        merging: 'orch:merging',
        mergeFailed: 'orch:merge-failed',
      },
      labelConfig: {},
      defaults: {
        planner: 'claude',
        coder: 'claude',
        reviewer: 'claude',
        doneMode: 'pr-ready',
        notifyPriority: 'normal',
        prMentions: [],
      },
      verify: [],
      planning: {
        prdDirectory: 'docs/prd',
      },
      selectors: {
        includeLabelsAny: ['orch:ready'],
        excludeLabelsAny: ['orch:blocked'],
      },
      agents: {},
      mergeQueue: {
        enabled: false,
        batchSize: 5,
        mergeMethod: 'merge',
        retryFlakyOnce: true,
        requireApproval: true,
        stagingBranchPrefix: 'orch/staging',
      },
    }],
    workflows: {},
  }
}

describe('runtime settings', () => {
  let tmpDir: string
  let db: Database.Database
  let baseConfig: Config

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-settings-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    baseConfig = makeMinimalConfig()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists non-project runtime settings with base values by default', () => {
    const settings = listRuntimeSettings(baseConfig, db)
    expect(settings).toHaveLength(56)
    expect(settings.map((s) => s.key)).toContain('security.maxCostPerRunUsd')
    expect(settings.map((s) => s.key)).toContain('github.tokenEnv')
    expect(settings.map((s) => s.key)).toContain('cost.subscriptionMetered')
    expect(settings.map((s) => s.key)).toContain('workerProfiles')

    const poll = settings.find((setting) => setting.key === 'github.pollIntervalSeconds')
    expect(poll).toMatchObject({
      source: 'base',
      baseValue: 300,
      effectiveValue: 300,
      overrideValue: null,
    })
  })

  it('applies set and clear override mutations', () => {
    const setResult = setRuntimeSettingOverride(
      baseConfig,
      db,
      'github.pollIntervalSeconds',
      '120',
      'test',
    )
    expect(setResult.changed).toBe(true)
    expect(setResult.setting.source).toBe('override')
    expect(setResult.setting.effectiveValue).toBe(120)

    const effective = resolveConfigWithRuntimeSettings(baseConfig, db)
    expect(effective.github.pollIntervalSeconds).toBe(120)

    const clearResult = clearRuntimeSettingOverride(baseConfig, db, 'github.pollIntervalSeconds')
    expect(clearResult.changed).toBe(true)
    expect(clearResult.setting.source).toBe('base')
    expect(clearResult.setting.effectiveValue).toBe(300)
  })

  it('ignores invalid stored rows and falls back to base values', () => {
    db.prepare(
      `INSERT INTO settings_overrides (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, datetime('now'))`,
    ).run('github.pollIntervalSeconds', '"oops"', 'test')

    const settings = listRuntimeSettings(baseConfig, db)
    const poll = settings.find((setting) => setting.key === 'github.pollIntervalSeconds')
    expect(poll?.source).toBe('base')
    expect(poll?.effectiveValue).toBe(300)
  })

  it('rejects malformed numeric override input strings', () => {
    expect(() => {
      setRuntimeSettingOverride(
        baseConfig,
        db,
        'github.pollIntervalSeconds',
        '120abc',
        'test',
      )
    }).toThrow('github.pollIntervalSeconds must be a finite number')

    expect(() => {
      setRuntimeSettingOverride(
        baseConfig,
        db,
        'security.maxDailyCostUsd',
        '12.5usd',
        'test',
      )
    }).toThrow('security.maxDailyCostUsd must be a finite number')
  })

  it('supports nullable string overrides', () => {
    const setResult = setRuntimeSettingOverride(
      baseConfig,
      db,
      'mcp.authTokenEnv',
      'MCP_TOKEN',
      'test',
    )
    expect(setResult.changed).toBe(true)
    expect(setResult.setting.effectiveValue).toBe('MCP_TOKEN')
    expect(setResult.setting.source).toBe('override')

    const nullResult = setRuntimeSettingOverride(
      baseConfig,
      db,
      'mcp.authTokenEnv',
      'null',
      'test',
    )
    expect(nullResult.changed).toBe(true)
    expect(nullResult.setting.effectiveValue).toBeNull()
    expect(nullResult.setting.source).toBe('override')
  })

  it('redacts sensitive worker profile env values in runtime settings snapshots', () => {
    baseConfig.workerProfiles = {
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

    const settings = listRuntimeSettings(baseConfig, db)
    const workerProfiles = settings.find((setting) => setting.key === 'workerProfiles')
    expect(workerProfiles).toBeDefined()
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
  })

  it('rejects malformed JSON structure for json runtime settings', () => {
    expect(() => {
      setRuntimeSettingOverride(
        baseConfig,
        db,
        'notifications.channels',
        '{}',
        'test',
      )
    }).toThrow('notifications.channels has invalid structure')

    expect(() => {
      setRuntimeSettingOverride(
        baseConfig,
        db,
        'workerProfiles',
        '{"codexCli":{"type":"codex"}}',
        'test',
      )
    }).toThrow('workerProfiles has invalid structure')
  })

  it('marks storage.dbPath as read-only for runtime overrides', () => {
    const settings = listRuntimeSettings(baseConfig, db)
    const dbPath = settings.find((setting) => setting.key === 'storage.dbPath')
    expect(dbPath?.mutable).toBe(false)

    expect(() => {
      setRuntimeSettingOverride(
        baseConfig,
        db,
        'storage.dbPath',
        '/tmp/alternate.db',
        'test',
      )
    }).toThrow('storage.dbPath is read-only at runtime and cannot be overridden')

    expect(() => {
      clearRuntimeSettingOverride(baseConfig, db, 'storage.dbPath')
    }).toThrow('storage.dbPath is read-only at runtime and cannot be overridden')
  })
})
