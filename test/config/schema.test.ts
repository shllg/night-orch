import { describe, it, expect } from 'vitest'
import { ConfigSchema } from '../../src/config/schema.js'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { resolve } from 'node:path'

function loadExampleConfig() {
  const content = readFileSync(
    resolve(import.meta.dirname, '../../examples/config.example.yaml'),
    'utf-8',
  )
  return parseYaml(content)
}

describe('ConfigSchema', () => {
  it('parses the example config without errors', () => {
    const raw = loadExampleConfig()
    const result = ConfigSchema.safeParse(raw)
    if (!result.success) {
      console.error(result.error.issues)
    }
    expect(result.success).toBe(true)
  })

  it('requires version to be 1', () => {
    const raw = loadExampleConfig()
    raw.version = 2
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('requires at least one repo', () => {
    const raw = loadExampleConfig()
    raw.repos = []
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('At least one repository')
    }
  })

  it('rejects literal tokens in tokenEnv', () => {
    const raw = loadExampleConfig()
    raw.github.tokenEnv = 'ghp_abcdef1234567890abcdef1234567890abcd'
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('environment variable name')
    }
  })

  it('rejects github_pat_ literal tokens in tokenEnv', () => {
    const raw = loadExampleConfig()
    raw.github.tokenEnv = 'github_pat_some_long_token_value'
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('validates repo format as owner/name', () => {
    const raw = loadExampleConfig()
    raw.repos[0].repo = 'invalid-no-slash'
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('accepts valid forge types', () => {
    const raw = loadExampleConfig()
    raw.repos[0].forge = 'forgejo'
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
  })

  it('rejects invalid forge types', () => {
    const raw = loadExampleConfig()
    raw.repos[0].forge = 'gitlab'
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('applies defaults for optional fields', () => {
    const minimal = {
      version: 1,
      github: {
        tokenEnv: 'GITHUB_TOKEN',
      },
      repos: [
        {
          repo: 'org/repo',
          localPath: '/tmp/repo',
        },
      ],
    }
    const result = ConfigSchema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.github.pollIntervalSeconds).toBe(300)
      expect(result.data.loop.maxReviewIterations).toBe(4)
      expect(result.data.security.maxDailyCostUsd).toBe(50)
      expect(result.data.cost.model).toBe('pay-per-use')
      expect(result.data.metrics.host).toBe('0.0.0.0')
      expect(result.data.repos[0]?.maxConcurrentRuns).toBe(1)
      expect(result.data.repos[0]?.baseBranch).toBe('main')
      expect(result.data.repos[0]?.branchPrefix).toBe('orch')
    }
  })

  it('validates repos[].maxConcurrentRuns range', () => {
    const raw = loadExampleConfig()
    raw.repos[0].maxConcurrentRuns = 0
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('normalizes ready labels from string to array', () => {
    const raw = loadExampleConfig()
    raw.repos[0].labels.ready = 'orch:ready'
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.repos[0]?.labels.ready).toEqual(['orch:ready'])
    }
  })

  it('applies planning defaults for labels and PRD directory', () => {
    const minimal = {
      version: 1,
      github: { tokenEnv: 'GITHUB_TOKEN' },
      repos: [{ repo: 'org/repo', localPath: '/tmp/repo' }],
    }
    const result = ConfigSchema.parse(minimal)
    expect(result.repos[0]!.labels.planning).toBe('orch:planning')
    expect(result.repos[0]!.planning.prdDirectory).toBe('docs/prd')
  })

  it('validates worker profile schema', () => {
    const raw = loadExampleConfig()
    raw.workerProfiles['claude-default'].workerTimeoutSeconds = -1
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('validates security config defaults', () => {
    const minimal = {
      version: 1,
      github: { tokenEnv: 'GITHUB_TOKEN' },
      repos: [{ repo: 'org/repo', localPath: '/tmp/repo' }],
    }
    const result = ConfigSchema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.security.maxChangedFiles).toBe(50)
      expect(result.data.security.maxChangedLines).toBe(5000)
      expect(result.data.security.maxCostPerRunUsd).toBe(10)
    }
  })

  it('accepts subscription cost model', () => {
    const raw = loadExampleConfig()
    raw.cost = { model: 'subscription' }
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cost.model).toBe('subscription')
    }
  })

  it('accepts configurable cost pricing by model', () => {
    const raw = loadExampleConfig()
    raw.cost = {
      model: 'pay-per-use',
      pricing: {
        defaultModel: 'claude-sonnet-4',
        models: {
          'claude-sonnet-4': {
            inputUsdPerMillionTokens: 3,
            outputUsdPerMillionTokens: 15,
            minuteUsd: 0.01,
          },
          'gpt-5': {
            inputUsdPerMillionTokens: 1.25,
            outputUsdPerMillionTokens: 10,
            minuteUsd: 0.02,
          },
        },
      },
    }
    raw.workerProfiles['claude-default'].pricingModel = 'claude-sonnet-4'

    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cost.pricing?.defaultModel).toBe('claude-sonnet-4')
      expect(result.data.cost.pricing?.models['gpt-5']?.outputUsdPerMillionTokens).toBe(10)
      expect(result.data.workerProfiles['claude-default']?.pricingModel).toBe('claude-sonnet-4')
    }
  })

  it('rejects negative configured pricing rates', () => {
    const raw = loadExampleConfig()
    raw.cost = {
      model: 'pay-per-use',
      pricing: {
        models: {
          default: {
            inputUsdPerMillionTokens: -1,
            outputUsdPerMillionTokens: 15,
            minuteUsd: 0.008,
          },
        },
      },
    }
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('excludes orch:needs-human by default', () => {
    const minimal = {
      version: 1,
      github: { tokenEnv: 'GITHUB_TOKEN' },
      repos: [{ repo: 'org/repo', localPath: '/tmp/repo' }],
    }
    const result = ConfigSchema.parse(minimal)
    expect(result.repos[0]!.selectors.excludeLabelsAny).toContain('orch:needs-human')
  })

  it('accepts per-repo labelConfig overrides', () => {
    const raw = loadExampleConfig()
    raw.repos[0].labelConfig = {
      'orch:ready': {
        color: '0E8A16',
        description: 'Queued for processing',
      },
    }

    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.repos[0]?.labelConfig['orch:ready']?.color).toBe('0E8A16')
    }
  })

  it('rejects invalid labelConfig colors', () => {
    const raw = loadExampleConfig()
    raw.repos[0].labelConfig = {
      'orch:ready': {
        color: 'XYZ',
      },
    }

    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('accepts linkedProjects and kanban label flow config', () => {
    const raw = loadExampleConfig()
    raw.repos[0].linkedProjects = ['org/tracker', 'org/platform-triage']
    raw.repos[0].kanban = {
      triggerLabel: 'flow:kanban',
      labels: {
        ready: ['kanban:todo'],
        running: 'kanban:doing',
        blocked: 'kanban:blocked',
        needsHuman: 'kanban:needs-human',
        reviewReady: 'kanban:review',
        error: 'kanban:error',
        retry: 'kanban:retry',
        planning: 'kanban:planning',
        mergeQueued: 'kanban:merge-queued',
        merging: 'kanban:merging',
        mergeFailed: 'kanban:merge-failed',
      },
    }

    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.repos[0]?.linkedProjects).toEqual(['org/tracker', 'org/platform-triage'])
      expect(result.data.repos[0]?.kanban?.triggerLabel).toBe('flow:kanban')
      expect(result.data.repos[0]?.kanban?.labels.ready).toEqual(['kanban:todo'])
    }
  })

  it('rejects invalid linkedProjects format', () => {
    const raw = loadExampleConfig()
    raw.repos[0].linkedProjects = ['invalid-project-slug']
    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('accepts triage workflow routing with workflow role/profile overrides', () => {
    const raw = loadExampleConfig()
    raw.workflows = {
      'fast-trivial': {
        roles: {
          coder: 'codex',
          reviewer: 'codex',
        },
        agents: {
          codex: 'codex-default',
        },
        steps: [
          { type: 'worker', id: 'code', role: 'coder' },
          { type: 'verify', id: 'verify' },
          { type: 'decide', id: 'decide', onIterate: 'code', requireReview: false },
        ],
      },
    }
    raw.repos[0].workflowByTriage = { trivial: 'fast-trivial' }

    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.repos[0]?.workflowByTriage?.trivial).toBe('fast-trivial')
      expect(result.data.workflows['fast-trivial']?.roles?.coder).toBe('codex')
      expect(result.data.workflows['fast-trivial']?.agents?.['codex']).toBe('codex-default')
      const decideStep = result.data.workflows['fast-trivial']?.steps[2]
      if (decideStep && decideStep.type === 'decide') {
        expect(decideStep.requireReview).toBe(false)
      }
    }
  })

  it('rejects unsupported workflowByTriage keys', () => {
    const raw = loadExampleConfig()
    raw.repos[0].workflowByTriage = {
      trivial: 'fast-trivial',
      architectural: 'full',
    }

    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('accepts bootstrap failureHints and applies default output mode', () => {
    const raw = loadExampleConfig()
    raw.repos[0].environment.bootstrap = [
      {
        command: 'bundle exec rails db:prepare',
        when: 'always',
        failureHints: [
          {
            contains: 'role "app_user" does not exist',
            message: 'Create PostgreSQL role "app_user".',
          },
        ],
      },
    ]

    const result = ConfigSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      const hint = result.data.repos[0]?.environment?.bootstrap[0]?.failureHints[0]
      expect(hint?.output).toBe('combined')
    }
  })
})
