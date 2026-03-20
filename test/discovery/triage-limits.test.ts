import { describe, it, expect } from 'vitest'
import { adjustLimitsForTriage } from '../../src/discovery/triage.js'

describe('adjustLimitsForTriage', () => {
  const baseLimits = { maxReviewIterations: 4, maxTotalAgentPasses: 10 }
  const baseTimeout = 1800

  it('trivial: halves iterations and reduces timeout', () => {
    const result = adjustLimitsForTriage(baseLimits, baseTimeout, { level: 'trivial', reason: '' })
    expect(result.maxReviewIterations).toBe(2)
    expect(result.maxTotalAgentPasses).toBe(5)
    expect(result.workerTimeoutSeconds).toBe(1080)
  })

  it('standard: no change', () => {
    const result = adjustLimitsForTriage(baseLimits, baseTimeout, { level: 'standard', reason: '' })
    expect(result.maxReviewIterations).toBe(4)
    expect(result.maxTotalAgentPasses).toBe(10)
    expect(result.workerTimeoutSeconds).toBe(1800)
  })

  it('architectural: increases limits', () => {
    const result = adjustLimitsForTriage(baseLimits, baseTimeout, { level: 'architectural', reason: '' })
    expect(result.maxReviewIterations).toBe(6)
    expect(result.maxTotalAgentPasses).toBe(15)
    expect(result.workerTimeoutSeconds).toBe(2700)
  })

  it('architectural: caps at absolute max', () => {
    const result = adjustLimitsForTriage(
      { maxReviewIterations: 15, maxTotalAgentPasses: 15 },
      6000,
      { level: 'architectural', reason: '' },
      { iterations: 20, timeout: 7200 },
    )
    expect(result.maxReviewIterations).toBeLessThanOrEqual(20)
    expect(result.workerTimeoutSeconds).toBeLessThanOrEqual(7200)
  })
})
