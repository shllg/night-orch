import { describe, it, expect } from 'vitest'
import { prepareEnvironment } from '../../src/environment/manager.js'
import type { RepoConfig } from '../../src/config/schema.js'

function repoWith(environment: unknown): RepoConfig {
  return { environment } as unknown as RepoConfig
}

describe('prepareEnvironment', () => {
  it('allocates a port from the configured range and records it in usedPorts', () => {
    const usedPorts: number[] = []
    const result = prepareEnvironment({
      repo: 'shllg/dailywerk',
      issueNumber: 341,
      runId: 'run-ABC',
      repoConfig: repoWith({ ports: { min: 5400, max: 5499 }, beforeRun: [], afterRun: [] }),
      usedPorts,
    })

    expect(result.tokens.port).toBe(5400)
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
      repoConfig: repoWith({ ports: { min: 5400, max: 5499 }, beforeRun: [], afterRun: [] }),
      usedPorts,
    })
    expect(result.tokens.port).toBe(5401)
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
    expect(result.tokens.project).toBe('r-2-y')
  })
})
