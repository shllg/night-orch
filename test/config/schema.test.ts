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
      expect(result.data.repos[0]?.baseBranch).toBe('main')
      expect(result.data.repos[0]?.branchPrefix).toBe('orch')
    }
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

  it('excludes orch:needs-human by default', () => {
    const minimal = {
      version: 1,
      github: { tokenEnv: 'GITHUB_TOKEN' },
      repos: [{ repo: 'org/repo', localPath: '/tmp/repo' }],
    }
    const result = ConfigSchema.parse(minimal)
    expect(result.repos[0]!.selectors.excludeLabelsAny).toContain('orch:needs-human')
  })
})
