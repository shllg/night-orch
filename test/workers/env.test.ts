import { delimiter, join } from 'node:path'
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
  const splitPath = (value: string | undefined): string[] => (value ?? '').split(delimiter).filter(Boolean)

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
    const pathSegments = splitPath(env['PATH'])
    expect(pathSegments).toContain('/usr/bin')
    expect(pathSegments).toContain(join('/home/test', '.local/bin'))
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

  it('forwards MISE_TRUSTED_CONFIG_PATHS from process.env', () => {
    process.env['MISE_TRUSTED_CONFIG_PATHS'] = '/home/test/.night-orch/worktrees'
    const env = buildWorkerEnv(baseProfile)
    expect(env['MISE_TRUSTED_CONFIG_PATHS']).toBe('/home/test/.night-orch/worktrees')
    const verifierEnv = buildVerifierEnv()
    expect(verifierEnv['MISE_TRUSTED_CONFIG_PATHS']).toBe('/home/test/.night-orch/worktrees')
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
    const pathSegments = splitPath(env['PATH'])
    expect(pathSegments).toContain('/usr/bin')
    expect(pathSegments).toContain(join('/home/test', '.local/bin'))
    expect(env['HOME']).toBe('/home/test')
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['NPM_TOKEN']).toBeUndefined()
    expect(env['DOCKER_AUTH_CONFIG']).toBeUndefined()
  })

  it('buildVerifierEnv forwards docker/compose engine vars so compose hooks reach the engine', () => {
    process.env['DOCKER_HOST'] = 'tcp://localhost:2375'
    process.env['COMPOSE_PROJECT_NAME'] = 'proj'
    const env = buildVerifierEnv()
    expect(env['DOCKER_HOST']).toBe('tcp://localhost:2375')
    expect(env['COMPOSE_PROJECT_NAME']).toBe('proj')
    // but the docker registry credential blob is still a secret and excluded
    expect(env['DOCKER_AUTH_CONFIG']).toBeUndefined()
  })
})
