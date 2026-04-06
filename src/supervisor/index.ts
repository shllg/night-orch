import { fork, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync, unlinkSync, watchFile, unwatchFile } from 'node:fs'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'
import { UpdateStatusTracker } from './status.js'
import { probeHealthEndpoint, resolveSupervisorHealthTargets, type SupervisorHealthTargets } from './health.js'
import { rollbackToCheckpoint, runUpdate, type UpdateResult } from './updater.js'

interface ManagedChild {
  name: string
  args: string[]
  process: ChildProcess | null
  status: 'running' | 'draining' | 'stopped'
  restartCount: number
  lastStartedAt: number
  /**
   * Pending delayed-respawn timer for this child. Tracked so that
   * `respawnAll()` and `shutdown()` can cancel any in-flight respawn
   * before spawning a fresh process — otherwise the stale timer fires
   * after the new spawn and produces a duplicate child.
   */
  pendingRespawn: NodeJS.Timeout | null
}

export interface SupervisorOptions {
  projectRoot: string
  globalArgs: string[]
  webArgs: string[]
  dataDir: string
}

const MAX_RESTART_BACKOFF_MS = 30_000
const BASE_RESTART_DELAY_MS = 1_000
const POST_UPDATE_HEALTH_TIMEOUT_MS = 90_000
const POST_UPDATE_HEALTH_INTERVAL_MS = 2_000
const HTTP_HEALTH_TIMEOUT_MS = 5_000
const RUN_PROCESS_STABILIZATION_MS = 10_000

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
        pendingRespawn: null,
      },
      {
        name: 'web',
        args: [...this.options.globalArgs, 'web', ...this.options.webArgs],
        process: null,
        status: 'stopped',
        restartCount: 0,
        lastStartedAt: 0,
        pendingRespawn: null,
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

    // Clear any lingering delayed-respawn timer for this child — without
    // this a stale timer queued during a crash loop would fire after the
    // fresh spawn below and create a duplicate child process.
    if (child.pendingRespawn) {
      clearTimeout(child.pendingRespawn)
      child.pendingRespawn = null
    }

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

      child.pendingRespawn = setTimeout(() => {
        child.pendingRespawn = null
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
    try {
      this.status.transition('draining', {
        completedAt: undefined,
        error: undefined,
      })
      logger.info('Draining children for update...')
      await this.drainAll()

      const result = await runUpdate(this.options.projectRoot, this.status)
      if (!result.success) {
        logger.error({ error: result.error }, 'Update failed before restart')
        this.respawnAll()
        return
      }

      logger.info(
        { from: shortCommit(result.previousCommit), to: shortCommit(result.newCommit) },
        'Update build complete — respawning children',
      )
      this.status.transition('restarting', {
        targetCommit: result.newCommit,
        error: undefined,
      })
      this.respawnAll()

      this.status.transition('health-checking', {
        targetCommit: result.newCommit,
      })
      const healthTargets = this.resolveHealthTargets()
      const health = await this.waitForChildrenHealthy(healthTargets)
      if (health.ok) {
        this.status.transition('idle', {
          completedAt: nowUtcIso(),
          error: undefined,
        })
        logger.info({ commit: shortCommit(result.newCommit) }, 'Update complete — health checks passed')
        return
      }

      await this.handleHealthCheckFailure(result, health.issues)
    } catch (err) {
      const message = `Update orchestration failed: ${(err as Error).message}`
      logger.error({ err }, message)
      this.status.transition('failed', { error: message, completedAt: nowUtcIso() })
      this.respawnAll()
    } finally {
      this.updating = false
      this.removeTriggerFile()
    }
  }

  private async handleHealthCheckFailure(result: UpdateResult, issues: string[]): Promise<void> {
    const initialFailure = this.formatHealthFailure(result.newCommit, issues)
    logger.error(
      {
        targetCommit: result.newCommit,
        issues,
        childStates: this.snapshotChildStates(),
      },
      'Post-update health checks failed — rolling back to known-good commit',
    )

    await this.drainAll()
    const rollback = await rollbackToCheckpoint(
      this.options.projectRoot,
      this.status,
      {
        previousCommit: result.previousCommit,
        previousRef: result.previousRef,
      },
      initialFailure,
    )

    if (!rollback.success) {
      const finalMessage = `${initialFailure}; rollback failed: ${rollback.error ?? 'unknown rollback error'}`
      this.status.transition('failed', { error: finalMessage, completedAt: nowUtcIso() })
      logger.error({ error: rollback.error }, 'Rollback failed after health-check failure')
      this.respawnAll()
      return
    }

    this.status.transition('restarting', {
      targetCommit: result.previousCommit,
      error: initialFailure,
    })
    this.respawnAll()

    this.status.transition('health-checking', {
      targetCommit: result.previousCommit,
      error: initialFailure,
    })
    const rollbackHealthTargets = this.resolveHealthTargets()
    const rollbackHealth = await this.waitForChildrenHealthy(rollbackHealthTargets)
    if (!rollbackHealth.ok) {
      const rollbackFailure = this.formatHealthFailure(result.previousCommit, rollbackHealth.issues)
      const finalMessage = `${initialFailure}; rollback health checks also failed: ${rollbackFailure}`
      this.status.transition('failed', { error: finalMessage, completedAt: nowUtcIso() })
      logger.error(
        {
          rollbackIssues: rollbackHealth.issues,
          childStates: this.snapshotChildStates(),
        },
        'Rollback completed but services are still unhealthy',
      )
      return
    }

    const finalMessage =
      `${initialFailure}; rolled back to ${shortCommit(result.previousCommit)} and restored service`
    this.status.transition('failed', { error: finalMessage, completedAt: nowUtcIso() })
    logger.error(
      {
        attemptedCommit: result.newCommit,
        restoredCommit: result.previousCommit,
      },
      'Update failed health checks and was rolled back',
    )
  }

  private async waitForChildrenHealthy(
    healthTargets: SupervisorHealthTargets,
  ): Promise<{ ok: true; issues: [] } | { ok: false; issues: string[] }> {
    const deadline = Date.now() + POST_UPDATE_HEALTH_TIMEOUT_MS
    let lastIssues: string[] = []

    while (Date.now() < deadline) {
      if (this.shuttingDown) {
        return { ok: false, issues: ['Supervisor is shutting down'] }
      }

      const issues: string[] = []

      for (const child of this.children) {
        if (!child.process) {
          issues.push(`child "${child.name}" exited before health checks passed`)
        }
      }

      if (issues.length === 0) {
        const webApi = await probeHealthEndpoint(healthTargets.webApiUrl, {
          timeoutMs: HTTP_HEALTH_TIMEOUT_MS,
          expectedStatus: 200,
          expectedContentTypePrefix: 'application/json',
          hostHeader: healthTargets.webHostHeader ?? undefined,
        })
        if (!webApi.ok) {
          issues.push(`web API check failed: ${webApi.detail}`)
        }

        const webFrontend = await probeHealthEndpoint(healthTargets.webFrontendUrl, {
          timeoutMs: HTTP_HEALTH_TIMEOUT_MS,
          expectedStatus: 200,
          expectedContentTypePrefix: 'text/html',
          hostHeader: healthTargets.webHostHeader ?? undefined,
        })
        if (!webFrontend.ok) {
          issues.push(`web frontend check failed: ${webFrontend.detail}`)
        }

        if (healthTargets.runMcpUrl) {
          const runMcp = await probeHealthEndpoint(healthTargets.runMcpUrl, {
            timeoutMs: HTTP_HEALTH_TIMEOUT_MS,
            expectedStatus: 200,
            expectedContentTypePrefix: 'application/json',
          })
          if (!runMcp.ok) {
            issues.push(`run server check failed: ${runMcp.detail}`)
          }
        } else {
          const runChild = this.children.find((candidate) => candidate.name === 'run')
          if (!runChild?.process) {
            issues.push('run process is not running')
          } else {
            const uptimeMs = Date.now() - runChild.lastStartedAt
            if (uptimeMs < RUN_PROCESS_STABILIZATION_MS) {
              issues.push(
                `run process still stabilizing (${uptimeMs}ms < ${RUN_PROCESS_STABILIZATION_MS}ms)`,
              )
            }
          }
        }
      }

      if (issues.length === 0) {
        return { ok: true, issues: [] }
      }

      lastIssues = issues
      await sleep(POST_UPDATE_HEALTH_INTERVAL_MS)
    }

    if (lastIssues.length === 0) {
      lastIssues = ['post-update health checks timed out']
    }
    return { ok: false, issues: lastIssues }
  }

  private respawnAll(): void {
    for (const child of this.children) {
      // Cancel any in-flight delayed-respawn before reset; spawn() will also
      // clear this defensively, but clearing here prevents a race window
      // where a stale timer fires between the restartCount reset and spawn.
      if (child.pendingRespawn) {
        clearTimeout(child.pendingRespawn)
        child.pendingRespawn = null
      }
      child.restartCount = 0
      this.spawn(child)
    }
  }

  private snapshotChildStates(): string[] {
    const now = Date.now()
    return this.children.map((child) => {
      const pid = child.process?.pid ?? 'none'
      const uptimeMs = child.lastStartedAt > 0 ? now - child.lastStartedAt : 0
      return `${child.name}: status=${child.status} pid=${pid} uptimeMs=${uptimeMs}`
    })
  }

  private formatHealthFailure(targetCommit: string, issues: string[]): string {
    const issueSummary = issues.length > 0 ? issues.join(' | ') : 'no diagnostics'
    const childSummary = this.snapshotChildStates().join(' | ')
    return `commit ${shortCommit(targetCommit)} failed health checks: ${issueSummary}; children: ${childSummary}`
  }

  private resolveHealthTargets(): SupervisorHealthTargets {
    const resolution = resolveSupervisorHealthTargets(
      this.options.projectRoot,
      this.options.globalArgs,
      this.options.webArgs,
    )
    for (const warning of resolution.warnings) {
      logger.warn({ warning }, 'Supervisor health-check configuration warning')
    }
    return resolution.targets
  }

  private shutdown(): void {
    this.shuttingDown = true
    logger.info('Supervisor shutting down...')
    // Cancel any pending delayed respawns so they don't fire during drain
    // and spawn a new child while we are trying to stop the existing ones.
    for (const child of this.children) {
      if (child.pendingRespawn) {
        clearTimeout(child.pendingRespawn)
        child.pendingRespawn = null
      }
    }
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

function shortCommit(commit: string): string {
  return commit.slice(0, 8)
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolveSleep) => {
    setTimeout(() => resolveSleep(), ms)
  })
}
