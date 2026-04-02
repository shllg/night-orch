import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type UpdateState = 'idle' | 'draining' | 'pulling' | 'building' | 'restarting' | 'rolling-back' | 'failed'

export interface UpdateStatus {
  state: UpdateState
  startedAt?: string
  completedAt?: string
  previousCommit?: string
  targetCommit?: string
  error?: string
}

const IDLE_STATUS: UpdateStatus = { state: 'idle' }

export class UpdateStatusTracker {
  constructor(private statusPath: string) {
    mkdirSync(dirname(statusPath), { recursive: true })
    this.write(IDLE_STATUS)
  }

  transition(state: UpdateState, extra?: Partial<UpdateStatus>): void {
    const current = this.read()
    this.write({ ...current, state, ...extra })
  }

  read(): UpdateStatus {
    try {
      return JSON.parse(readFileSync(this.statusPath, 'utf-8')) as UpdateStatus
    } catch {
      return IDLE_STATUS
    }
  }

  reset(): void {
    this.write(IDLE_STATUS)
  }

  private write(status: UpdateStatus): void {
    writeFileSync(this.statusPath, JSON.stringify(status, null, 2) + '\n')
  }
}
