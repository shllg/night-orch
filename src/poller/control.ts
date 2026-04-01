export type PollWaitResult = 'interval' | 'manual'

export type ManualPollTriggerState = 'woke-sleeper' | 'queued-next-cycle' | 'already-pending'

export interface ManualPollTriggerResult {
  accepted: true
  state: ManualPollTriggerState
}

export interface PollerControl {
  triggerPollCycle(): ManualPollTriggerResult
}

/**
 * Coordinates interval waiting with manual wake-up requests.
 * Manual requests are coalesced so repeated triggers schedule at most one
 * immediate cycle after the current cycle finishes.
 */
export class PollCycleController implements PollerControl {
  private pendingManualCycle = false
  private waitResolver: (() => void) | null = null

  triggerPollCycle(): ManualPollTriggerResult {
    const alreadyPending = this.pendingManualCycle
    this.pendingManualCycle = true

    if (this.waitResolver) {
      const resolve = this.waitResolver
      this.waitResolver = null
      resolve()
      return { accepted: true, state: 'woke-sleeper' }
    }

    return {
      accepted: true,
      state: alreadyPending ? 'already-pending' : 'queued-next-cycle',
    }
  }

  async waitForNextCycle(intervalMs: number): Promise<PollWaitResult> {
    if (this.pendingManualCycle) {
      this.pendingManualCycle = false
      return 'manual'
    }

    return new Promise<PollWaitResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waitResolver = null
        resolve('interval')
      }, intervalMs)

      this.waitResolver = () => {
        clearTimeout(timer)
        this.waitResolver = null
        this.pendingManualCycle = false
        resolve('manual')
      }
    })
  }
}
