import { afterEach, describe, expect, it, vi } from 'vitest'
import { PollCycleController } from '../../src/poller/control.js'

describe('PollCycleController', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for interval when no manual trigger is pending', async () => {
    vi.useFakeTimers()
    const controller = new PollCycleController()

    const waitPromise = controller.waitForNextCycle(1000)
    await vi.advanceTimersByTimeAsync(1000)

    await expect(waitPromise).resolves.toBe('interval')
  })

  it('wakes interval wait when a manual trigger arrives', async () => {
    vi.useFakeTimers()
    const controller = new PollCycleController()

    const waitPromise = controller.waitForNextCycle(60_000)
    const trigger = controller.triggerPollCycle()

    expect(trigger.state).toBe('woke-sleeper')
    await expect(waitPromise).resolves.toBe('manual')
  })

  it('coalesces repeated manual triggers while a cycle is running', async () => {
    const controller = new PollCycleController()

    const first = controller.triggerPollCycle()
    const second = controller.triggerPollCycle()
    expect(first.state).toBe('queued-next-cycle')
    expect(second.state).toBe('already-pending')

    await expect(controller.waitForNextCycle(1000)).resolves.toBe('manual')

    vi.useFakeTimers()
    const nextWait = controller.waitForNextCycle(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(nextWait).resolves.toBe('interval')
  })
})
