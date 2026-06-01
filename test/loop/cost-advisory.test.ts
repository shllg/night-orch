import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionAdvisoryWarnings } from '../../src/loop/cost/advisory.js'
import { logger } from '../../src/utils/logger.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn() },
}))

const loggerWarn = vi.mocked(logger.warn)

describe('SubscriptionAdvisoryWarnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deduplicates warning keys while they remain in the bounded cache', () => {
    const warnings = new SubscriptionAdvisoryWarnings(2)

    warnings.warnOnce('run-1:soft', {}, 'soft limit')
    warnings.warnOnce('run-1:soft', {}, 'soft limit')

    expect(loggerWarn).toHaveBeenCalledTimes(1)
  })

  it('evicts the oldest key when the cache reaches its bound', () => {
    const warnings = new SubscriptionAdvisoryWarnings(2)

    warnings.warnOnce('run-1:soft', {}, 'soft limit')
    warnings.warnOnce('run-2:soft', {}, 'soft limit')
    warnings.warnOnce('run-3:soft', {}, 'soft limit')
    warnings.warnOnce('run-1:soft', {}, 'soft limit')

    expect(loggerWarn).toHaveBeenCalledTimes(4)
  })
})
