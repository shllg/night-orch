import { describe, it, expect } from 'vitest'
import { prepareEnvironment, releaseEnvironmentPorts } from '../../src/environment/manager.js'
import type { RepoConfig } from '../../src/config/schema.js'

function repoWith(environment: unknown): RepoConfig {
  return { environment } as unknown as RepoConfig
}

describe('prepareEnvironment', () => {
  it('allocates a port from the single (default) pool and records it in usedPorts', () => {
    const usedPorts: number[] = []
    const result = prepareEnvironment({
      repo: 'shllg/dailywerk',
      issueNumber: 341,
      runId: 'run-ABC',
      repoConfig: repoWith({ ports: { default: { min: 5400, max: 5499 } }, beforeRun: [], afterRun: [] }),
      usedPorts,
    })

    expect(result.tokens.port).toBe(5400)
    expect(result.tokens.ports).toEqual({ default: 5400 })
    expect(usedPorts).toContain(5400)
    expect(result.tokens.issue).toBe(341)
    expect(result.tokens.run).toBe('abc')
    expect(result.tokens.project).toBe('dailywerk-341-abc')
  })

  it('skips a port already in use', () => {
    const usedPorts = [5400]
    const result = prepareEnvironment({
      repo: 'o/r',
      issueNumber: 1,
      runId: 'run-x',
      repoConfig: repoWith({ ports: { default: { min: 5400, max: 5499 } }, beforeRun: [], afterRun: [] }),
      usedPorts,
    })
    expect(result.tokens.port).toBe(5401)
  })

  it('allocates one distinct port per named pool; {port} is the first pool', () => {
    const usedPorts: number[] = []
    const result = prepareEnvironment({
      repo: 'o/r',
      issueNumber: 7,
      runId: 'run-z',
      repoConfig: repoWith({
        ports: {
          postgres: { min: 5460, max: 5499 },
          redis: { min: 6460, max: 6499 },
          rustfs: { min: 9460, max: 9499 },
        },
        beforeRun: [],
        afterRun: [],
      }),
      usedPorts,
    })
    expect(result.tokens.ports).toEqual({ postgres: 5460, redis: 6460, rustfs: 9460 })
    expect(result.tokens.port).toBe(5460) // first pool
    expect(usedPorts).toEqual([5460, 6460, 9460])
  })

  it('gives concurrent runs distinct ports per pool (no collisions)', () => {
    const usedPorts: number[] = []
    const cfg = repoWith({
      ports: { postgres: { min: 5460, max: 5499 }, redis: { min: 6460, max: 6499 } },
      beforeRun: [],
      afterRun: [],
    })
    const a = prepareEnvironment({ repo: 'o/r', issueNumber: 1, runId: 'run-a', repoConfig: cfg, usedPorts })
    const b = prepareEnvironment({ repo: 'o/r', issueNumber: 2, runId: 'run-b', repoConfig: cfg, usedPorts })
    expect(a.tokens.ports).toEqual({ postgres: 5460, redis: 6460 })
    expect(b.tokens.ports).toEqual({ postgres: 5461, redis: 6461 })
  })

  it('allocates no port when ports are not configured', () => {
    const result = prepareEnvironment({
      repo: 'o/r',
      issueNumber: 2,
      runId: 'run-y',
      repoConfig: repoWith({ beforeRun: [], afterRun: [] }),
      usedPorts: [],
    })
    expect(result.tokens.port).toBeUndefined()
    expect(result.tokens.ports).toBeUndefined()
    expect(result.tokens.project).toBe('r-2-y')
  })

  it('throws with the pool range when a pool is exhausted', () => {
    const usedPorts = [5460, 5461]
    expect(() =>
      prepareEnvironment({
        repo: 'o/r',
        issueNumber: 1,
        runId: 'run-x',
        repoConfig: repoWith({ ports: { postgres: { min: 5460, max: 5461 } }, beforeRun: [], afterRun: [] }),
        usedPorts,
      }),
    ).toThrow(/exhausted/)
  })
})

describe('releaseEnvironmentPorts', () => {
  it('frees a run\'s ports so a later run reuses them', () => {
    const usedPorts: number[] = []
    const cfg = repoWith({
      ports: { postgres: { min: 5460, max: 5460 }, redis: { min: 6460, max: 6460 } },
      beforeRun: [],
      afterRun: [],
    })
    const first = prepareEnvironment({ repo: 'o/r', issueNumber: 1, runId: 'run-a', repoConfig: cfg, usedPorts })
    expect(usedPorts).toEqual([5460, 6460])

    releaseEnvironmentPorts(usedPorts, first.tokens)
    expect(usedPorts).toEqual([])

    // Single-port pools would otherwise be exhausted without the release.
    const second = prepareEnvironment({ repo: 'o/r', issueNumber: 2, runId: 'run-b', repoConfig: cfg, usedPorts })
    expect(second.tokens.ports).toEqual({ postgres: 5460, redis: 6460 })
  })

  it('only removes the run\'s own ports, leaving others in use', () => {
    const usedPorts = [5460, 5461, 6460]
    releaseEnvironmentPorts(usedPorts, {
      issue: 1, run: 'r', port: 5460, ports: { postgres: 5460, redis: 6460 }, project: 'p',
    })
    expect(usedPorts).toEqual([5461])
  })

  it('is a no-op when no ports were allocated', () => {
    const usedPorts = [5460]
    releaseEnvironmentPorts(usedPorts, { issue: 1, run: 'r', project: 'p' })
    expect(usedPorts).toEqual([5460])
  })
})
