import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildWorkerEnv, buildVerifierEnv } from '../../src/workers/env.js'
import type { WorkerProfileInput } from '../../src/workers/types.js'

const baseProfile: WorkerProfileInput = {
  type: 'claude',
  command: 'claude',
  args: ['-p'],
  workerTimeoutSeconds: 1800,
  minimalEnv: true,
  runtimeWrapper: null,
  env: {},
}

describe('buildWorkerEnv', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env['PATH'] = '/usr/bin'
    process.env['HOME'] = '/home/test'
    process.env['GITHUB_TOKEN'] = 'ghp_secret'
    process.env['GH_TOKEN'] = 'gho_secret'
    process.env['MY_SECRET'] = 'shhh'
    process.env['MY_PASSWORD'] = 'pass123'
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-xxx'
    process.env['NPM_TOKEN'] = 'npm-secret'
    process.env['DOCKER_AUTH_CONFIG'] = '{"auths":{}}'
    process.env['GH_ENTERPRISE_TOKEN'] = 'gh-enterprise'
    process.env['AWS_SECRET_ACCESS_KEY'] = 'aws-secret'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('includes whitelisted vars in minimal mode', () => {
    const env = buildWorkerEnv(baseProfile)
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/home/test')
  })

  it('excludes GITHUB_TOKEN in minimal mode', () => {
    const env = buildWorkerEnv(baseProfile)
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['GH_TOKEN']).toBeUndefined()
  })

  it('excludes blacklisted vars even when in profile env', () => {
    const profile = { ...baseProfile, env: { GITHUB_TOKEN: 'should-not-pass' } }
    const env = buildWorkerEnv(profile)
    expect(env['GITHUB_TOKEN']).toBeUndefined()
  })

  it('excludes regex-matched blacklisted vars', () => {
    const env = buildWorkerEnv({ ...baseProfile, minimalEnv: false })
    expect(env['MY_SECRET']).toBeUndefined()
    expect(env['MY_PASSWORD']).toBeUndefined()
    expect(env['NPM_TOKEN']).toBeUndefined()
    expect(env['DOCKER_AUTH_CONFIG']).toBeUndefined()
    expect(env['GH_ENTERPRISE_TOKEN']).toBeUndefined()
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
  })

  it('adds profile env overrides (non-blacklisted)', () => {
    const profile = { ...baseProfile, env: { CUSTOM_VAR: 'custom-value' } }
    const env = buildWorkerEnv(profile)
    expect(env['CUSTOM_VAR']).toBe('custom-value')
  })

  it('excludes *_KEY vars from profile env overrides', () => {
    const profile = { ...baseProfile, env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' } }
    const env = buildWorkerEnv(profile)
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
  })

  it('non-minimal mode is deprecated and still enforces whitelist-only env', () => {
    const env = buildWorkerEnv({ ...baseProfile, minimalEnv: false })
    expect(env['PATH']).toBeDefined()
    expect(env['MY_SECRET']).toBeUndefined()
    expect(env['DOCKER_AUTH_CONFIG']).toBeUndefined()
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['GH_TOKEN']).toBeUndefined()
  })

  it('buildVerifierEnv returns strict whitelist without secrets', () => {
    const env = buildVerifierEnv()
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/home/test')
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['NPM_TOKEN']).toBeUndefined()
    expect(env['DOCKER_AUTH_CONFIG']).toBeUndefined()
  })
})
