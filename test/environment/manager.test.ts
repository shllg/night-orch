import { describe, it, expect } from 'vitest'
import { prepareEnvironment, releaseEnvironmentPorts } from '../../src/environment/manager.js'
import type { RepoConfig } from '../../src/config/schema.js'

function repoWith(environment: unknown): RepoConfig {
  return { environment } as unknown as RepoConfig
}

// High, rarely-occupied ranges so the real host-availability probe passes
// deterministically. Assert range membership + distinctness, not exact values.
const PG = { min: 51010, max: 51049 }
const REDIS = { min: 51060, max: 51099 }

function inRange(p: number | undefined, r: { min: number; max: number }): boolean {
  return p !== undefined && p >= r.min && p <= r.max
}

describe('prepareEnvironment', () => {
  it('allocates a port from the single (default) pool and records it in usedPorts', async () => {
    const usedPorts: number[] = []
    const result = await prepareEnvironment({
      repo: 'shllg/dailywerk',
      issueNumber: 341,
      runId: 'run-ABC',
      repoConfig: repoWith({ ports: { default: PG }, check: [], beforeRun: [], afterRun: [] }),
      usedPorts,
    })

    expect(inRange(result.tokens.port, PG)).toBe(true)
    expect(result.tokens.ports).toEqual({ default: result.tokens.port })
    expect(usedPorts).toContain(result.tokens.port)
    expect(result.tokens.issue).toBe(341)
    expect(result.tokens.run).toBe('abc')
    expect(result.tokens.project).toBe('dailywerk-341-abc')
  })

  it('skips a port already in use', async () => {
    const usedPorts = [PG.min]
    const result = await prepareEnvironment({
      repo: 'o/r',
      issueNumber: 1,
      runId: 'run-x',
      repoConfig: repoWith({ ports: { default: PG }, check: [], beforeRun: [], afterRun: [] }),
      usedPorts,
    })
    expect(result.tokens.port).not.toBe(PG.min)
    expect(inRange(result.tokens.port, PG)).toBe(true)
  })

  it('allocates one distinct port per named pool; {port} is the first pool', async () => {
    const usedPorts: number[] = []
    const result = await prepareEnvironment({
      repo: 'o/r',
      issueNumber: 7,
      runId: 'run-z',
      repoConfig: repoWith({ ports: { postgres: PG, redis: REDIS }, check: [], beforeRun: [], afterRun: [] }),
      usedPorts,
    })
    expect(inRange(result.tokens.ports?.postgres, PG)).toBe(true)
    expect(inRange(result.tokens.ports?.redis, REDIS)).toBe(true)
    expect(result.tokens.port).toBe(result.tokens.ports?.postgres) // first pool
    expect(usedPorts).toEqual([result.tokens.ports?.postgres, result.tokens.ports?.redis])
  })

  it('gives concurrent runs distinct ports per pool (no collisions)', async () => {
    const usedPorts: number[] = []
    const cfg = repoWith({ ports: { postgres: PG, redis: REDIS }, check: [], beforeRun: [], afterRun: [] })
    const [a, b] = await Promise.all([
      prepareEnvironment({ repo: 'o/r', issueNumber: 1, runId: 'run-a', repoConfig: cfg, usedPorts }),
      prepareEnvironment({ repo: 'o/r', issueNumber: 2, runId: 'run-b', repoConfig: cfg, usedPorts }),
    ])
    expect(a.tokens.ports?.postgres).not.toBe(b.tokens.ports?.postgres)
    expect(a.tokens.ports?.redis).not.toBe(b.tokens.ports?.redis)
  })

  it('allocates no port when ports are not configured', async () => {
    const result = await prepareEnvironment({
      repo: 'o/r',
      issueNumber: 2,
      runId: 'run-y',
      repoConfig: repoWith({ check: [], beforeRun: [], afterRun: [] }),
      usedPorts: [],
    })
    expect(result.tokens.port).toBeUndefined()
    expect(result.tokens.ports).toBeUndefined()
    expect(result.tokens.project).toBe('r-2-y')
  })

  it('throws when a pool is exhausted', async () => {
    const usedPorts = [51200, 51201]
    await expect(
      prepareEnvironment({
        repo: 'o/r',
        issueNumber: 1,
        runId: 'run-x',
        repoConfig: repoWith({ ports: { postgres: { min: 51200, max: 51201 } }, check: [], beforeRun: [], afterRun: [] }),
        usedPorts,
      }),
    ).rejects.toThrow(/exhausted/)
  })
})

describe('releaseEnvironmentPorts', () => {
  it("frees a run's ports so a later run reuses them", async () => {
    const usedPorts: number[] = []
    const cfg = repoWith({ ports: { postgres: PG, redis: REDIS }, check: [], beforeRun: [], afterRun: [] })
    const first = await prepareEnvironment({ repo: 'o/r', issueNumber: 1, runId: 'run-a', repoConfig: cfg, usedPorts })
    expect(usedPorts.length).toBe(2)

    releaseEnvironmentPorts(usedPorts, first.tokens)
    expect(usedPorts).toEqual([])
  })

  it("only removes the run's own ports, leaving others in use", () => {
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
