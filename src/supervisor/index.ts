import { fork, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync, unlinkSync, watchFile, unwatchFile } from 'node:fs'
import { logger } from '../utils/logger.js'
import { UpdateStatusTracker } from './status.js'
import { runUpdate } from './updater.js'

interface ManagedChild {
  name: string
  args: string[]
  process: ChildProcess | null
  status: 'running' | 'draining' | 'stopped'
  restartCount: number
  lastStartedAt: number
}

export interface SupervisorOptions {
  projectRoot: string
  globalArgs: string[]
  webArgs: string[]
  dataDir: string
}

const MAX_RESTART_BACKOFF_MS = 30_000
const BASE_RESTART_DELAY_MS = 1_000

export class Supervisor {
  private children: ManagedChild[] = []
  private shuttingDown = false
  private updating = false
  private status: UpdateStatusTracker
  private triggerFilePath: string
  private cliEntry: string

  constructor(private options: SupervisorOptions) {
    this.status = new UpdateStatusTracker(resolve(options.dataDir, 'update-status.json'))
    this.triggerFilePath = resolve(options.dataDir, 'update-requested')
    this.cliEntry = resolve(options.projectRoot, 'dist', 'cli', 'index.js')
  }

  async start(): Promise<void> {
    this.children = [
      {
        name: 'run',
        args: [...this.options.globalArgs, 'run'],
        process: null,
        status: 'stopped',
        restartCount: 0,
        lastStartedAt: 0,
      },
      {
        name: 'web',
        args: [...this.options.globalArgs, 'web', ...this.options.webArgs],
        process: null,
        status: 'stopped',
        restartCount: 0,
        lastStartedAt: 0,
      },
    ]

    // Register signal handlers
    const onSignal = () => {
      if (this.shuttingDown) {
        logger.warn('Forced shutdown — second signal')
        process.exit(1)
      }
      this.shutdown()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)

    // Spawn children
    for (const child of this.children) {
      this.spawn(child)
    }

    // Watch for update trigger file
    this.watchTriggerFile()

    logger.info('Supervisor started')
    // Keep alive
    await new Promise<void>(() => {})
  }

  private spawn(child: ManagedChild): void {
    if (this.shuttingDown) return

    const proc = fork(this.cliEntry, child.args, {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      cwd: this.options.projectRoot,
    })

    child.process = proc
    child.status = 'running'
    child.lastStartedAt = Date.now()

    proc.on('message', (msg: unknown) => {
      if (isUpdateRequest(msg)) {
        logger.info({ source: child.name }, 'Update requested via IPC')
        void this.triggerUpdate()
      }
    })

    proc.on('exit', (code, signal) => {
      child.process = null
      child.status = 'stopped'

      if (this.shuttingDown || this.updating) {
        logger.info({ child: child.name, code, signal }, 'Child exited (expected)')
        return
      }

      // Unexpected exit — auto-respawn with backoff
      const uptime = Date.now() - child.lastStartedAt
      if (uptime < 5_000) {
        child.restartCount++
      } else {
        child.restartCount = 0
      }

      const delay = Math.min(
        BASE_RESTART_DELAY_MS * Math.pow(2, child.restartCount),
        MAX_RESTART_BACKOFF_MS,
      )

      logger.warn(
        { child: child.name, code, signal, restartCount: child.restartCount, delayMs: delay },
        'Child exited unexpectedly — respawning',
      )

      setTimeout(() => {
        if (!this.shuttingDown && !this.updating) {
          this.spawn(child)
        }
      }, delay)
    })

    logger.info({ child: child.name, pid: proc.pid }, 'Spawned child')
  }

  private async drainAll(): Promise<void> {
    const drainPromises = this.children.map((child) => this.drainChild(child))
    await Promise.all(drainPromises)
  }

  private drainChild(child: ManagedChild): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!child.process) {
        resolve()
        return
      }

      child.status = 'draining'
      const timeout = setTimeout(() => {
        logger.warn({ child: child.name }, 'Drain timeout — sending SIGKILL')
        child.process?.kill('SIGKILL')
      }, 5 * 60 * 1000)

      child.process.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      child.process.kill('SIGTERM')
    })
  }

  async triggerUpdate(): Promise<void> {
    if (this.updating) {
      logger.info('Update already in progress — ignoring')
      return
    }
    if (this.shuttingDown) return

    this.updating = true

    // Drain children
    this.status.transition('draining')
    logger.info('Draining children for update...')
    await this.drainAll()

    // Run update
    const result = await runUpdate(this.options.projectRoot, this.status)

    if (result.success) {
      logger.info(
        { from: result.previousCommit.slice(0, 8), to: result.newCommit.slice(0, 8) },
        'Update complete — respawning children',
      )
      this.status.transition('restarting')
    } else {
      logger.error({ error: result.error }, 'Update failed')
    }

    // Respawn (even on failure — rollback should have restored old code)
    for (const child of this.children) {
      child.restartCount = 0
      this.spawn(child)
    }

    this.updating = false
    if (result.success) {
      this.status.transition('idle', { completedAt: new Date().toISOString() })
    }

    // Clean trigger file
    this.removeTriggerFile()
  }

  private shutdown(): void {
    this.shuttingDown = true
    logger.info('Supervisor shutting down...')
    unwatchFile(this.triggerFilePath)
    void this.drainAll().then(() => {
      logger.info('All children stopped')
      process.exit(0)
    })
  }

  private watchTriggerFile(): void {
    watchFile(this.triggerFilePath, { interval: 2000 }, () => {
      if (existsSync(this.triggerFilePath)) {
        logger.info('Update trigger file detected')
        void this.triggerUpdate()
      }
    })
  }

  private removeTriggerFile(): void {
    try {
      unlinkSync(this.triggerFilePath)
    } catch {
      // File may not exist
    }
  }
}

function isUpdateRequest(msg: unknown): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as Record<string, unknown>)['type'] === 'update-requested'
  )
}
