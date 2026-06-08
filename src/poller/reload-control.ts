import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { nowUtcIso } from '../utils/time.js'

export interface ExternalReloadTriggerResult {
  accepted: true
  state: 'queued-next-cycle'
  mechanism: 'trigger-file'
  triggerPath: string
}

/**
 * Resolve the trigger-file path for hot-reloading config. Hashed by dbPath so
 * multiple daemons on one host don't trip each other's reload signal.
 */
export function resolveExternalReloadTriggerPath(dbPath: string): string {
  const dbKey = createHash('sha256')
    .update(resolve(dbPath))
    .digest('hex')
    .slice(0, 16)
  return resolve(homedir(), '.config', 'night-orch', `reload-request-${dbKey}`)
}

/**
 * Write the reload trigger file. The running poller drains it between cycles
 * and reloads its config from disk.
 */
export function requestExternalReload(dbPath: string): ExternalReloadTriggerResult {
  const triggerPath = resolveExternalReloadTriggerPath(dbPath)
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
 * Coalesces config-reload requests from SIGHUP and an external trigger file.
 * The poll loop calls consume() between cycles and reloads config from disk
 * when it returns true. Multiple requests between consumes collapse to one.
 */
export class ReloadController {
  private pending = false
  private sigHandler: (() => void) | null = null

  constructor(private readonly triggerPath?: string) {}

  register(): () => void {
    if (this.sigHandler) return () => this.unregister()
    const handler = () => {
      this.pending = true
    }
    this.sigHandler = handler
    process.on('SIGHUP', handler)
    return () => this.unregister()
  }

  unregister(): void {
    if (this.sigHandler) {
      process.removeListener('SIGHUP', this.sigHandler)
      this.sigHandler = null
    }
  }

  /**
   * In-process reload request. Mirrors what SIGHUP / trigger file would do
   * so the IPC path from `night-orch reload` can drive the same logic when
   * the daemon runs in the same process as the requester.
   */
  requestReload(): void {
    this.pending = true
  }

  /** Drain pending reload requests. Returns true if a reload is needed. */
  consume(): boolean {
    let requested = this.pending
    this.pending = false
    if (this.triggerPath && existsSync(this.triggerPath)) {
      try {
        rmSync(this.triggerPath, { force: true })
        requested = true
      } catch {
        // Leave the file in place — we'll retry next cycle.
      }
    }
    return requested
  }
}
