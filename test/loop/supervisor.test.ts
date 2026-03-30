import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { superviseWorker } from '../../src/loop/supervisor.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { logger } from '../../src/utils/logger.js'

describe('superviseWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires warning at 80% of timeout', () => {
    const onStuck = vi.fn()
    const handle = superviseWorker('coder', 10_000, onStuck)

    vi.advanceTimersByTime(8_000)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'coder' }),
      expect.stringContaining('may be stuck'),
    )
    expect(onStuck).not.toHaveBeenCalled()

    handle.cancel()
  })

  it('fires onStuck at full timeout', () => {
    const onStuck = vi.fn()
    superviseWorker('coder', 10_000, onStuck)

    vi.advanceTimersByTime(10_000)
    expect(onStuck).toHaveBeenCalledTimes(1)
  })

  it('does not fire after cancel', () => {
    const onStuck = vi.fn()
    const handle = superviseWorker('coder', 10_000, onStuck)

    handle.cancel()
    vi.advanceTimersByTime(15_000)
    expect(onStuck).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
