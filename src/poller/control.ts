import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { nowUtcIso } from '../utils/time.js'

export type PollWaitResult = 'interval' | 'manual'

export type ManualPollTriggerState = 'woke-sleeper' | 'queued-next-cycle' | 'already-pending'

export interface ManualPollTriggerResult {
  accepted: true
  state: ManualPollTriggerState
}

export interface PollerControl {
  triggerPollCycle(): ManualPollTriggerResult
}

export interface ExternalPollTriggerResult {
  accepted: true
  state: 'queued-next-cycle'
  mechanism: 'trigger-file'
  triggerPath: string
}

const EXTERNAL_TRIGGER_POLL_INTERVAL_MS = 250

export function resolveExternalPollTriggerPath(dbPath: string): string {
  const dbKey = createHash('sha256')
    .update(resolve(dbPath))
    .digest('hex')
    .slice(0, 16)
  return resolve(homedir(), '.config', 'night-orch', `poll-request-${dbKey}`)
}

export function requestExternalPollCycle(dbPath: string): ExternalPollTriggerResult {
  const triggerPath = resolveExternalPollTriggerPath(dbPath)
  mkdirSync(resolve(homedir(), '.config', 'night-orch'), { recursive: true })
  writeFileSync(triggerPath, nowUtcIso())
  return {
    accepted: true,
    state: 'queued-next-cycle',
    mechanism: 'trigger-file',
    triggerPath,
  }
}

/**
 * Coordinates interval waiting with manual wake-up requests.
 * Manual requests are coalesced so repeated triggers schedule at most one
 * immediate cycle after the current cycle finishes.
 */
export class PollCycleController implements PollerControl {
  private pendingManualCycle = false
  private waitResolver: (() => void) | null = null

  constructor(private readonly externalTriggerPath?: string) {}

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
    if (this.pendingManualCycle || this.consumeExternalTrigger()) {
      this.pendingManualCycle = false
      return 'manual'
    }

    return new Promise<PollWaitResult>((resolve) => {
      let pollTimer: NodeJS.Timeout | null = null
      const cleanup = () => {
        this.waitResolver = null
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }

      const timer = setTimeout(() => {
        cleanup()
        resolve('interval')
      }, intervalMs)

      this.waitResolver = () => {
        clearTimeout(timer)
        cleanup()
        this.pendingManualCycle = false
        resolve('manual')
      }

      if (this.externalTriggerPath) {
        pollTimer = setInterval(() => {
          if (this.consumeExternalTrigger()) {
            this.waitResolver?.()
          }
        }, EXTERNAL_TRIGGER_POLL_INTERVAL_MS)
      }
    })
  }

  private consumeExternalTrigger(): boolean {
    if (!this.externalTriggerPath || !existsSync(this.externalTriggerPath)) {
      return false
    }

    try {
      rmSync(this.externalTriggerPath, { force: true })
      return true
    } catch {
      return false
    }
  }
}
