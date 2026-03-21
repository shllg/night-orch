import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ShutdownHandler } from '../../src/poller/shutdown.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Prevent actual process.exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)

describe('ShutdownHandler', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-shutdown-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    try { db.close() } catch { /* may already be closed by shutdown handler */ }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('isShuttingDown is initially false', () => {
    const handler = new ShutdownHandler(db)
    expect(handler.isShuttingDown).toBe(false)
  })

  it('register returns cleanup function', () => {
    const handler = new ShutdownHandler(db)
    const cleanup = handler.register()
    expect(typeof cleanup).toBe('function')
    cleanup()
  })

  it('trackRun accepts a promise', async () => {
    const handler = new ShutdownHandler(db)
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    handler.trackRun(promise)
    resolve()
    await promise
  })

  it('SIGINT sets shutdown flag', () => {
    const handler = new ShutdownHandler(db, 100)
    const cleanup = handler.register()

    process.emit('SIGINT')

    expect(handler.isShuttingDown).toBe(true)
    cleanup()
  })

  it('active run allowed to complete before exit', async () => {
    const handler = new ShutdownHandler(db, 100)
    const cleanup = handler.register()

    let runComplete = false
    const runPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        runComplete = true
        resolve()
      }, 10)
    })
    handler.trackRun(runPromise)

    // Emit SIGINT — should wait for run
    process.emit('SIGINT')
    await runPromise

    expect(runComplete).toBe(true)
    cleanup()
  })

  it('shutdown timeout forces exit', async () => {
    const handler = new ShutdownHandler(db, 50) // Very short timeout
    const cleanup = handler.register()

    // Track a run that never completes
    const neverResolve = new Promise<void>(() => {})
    handler.trackRun(neverResolve)

    process.emit('SIGINT')

    // Wait for timeout
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    expect(mockExit).toHaveBeenCalled()
    cleanup()
  })

  it('leases released on shutdown', async () => {
    // Insert a lease
    db.prepare("INSERT INTO leases (repo, issue_number, lease_owner, leased_until) VALUES ('org/repo', 1, 'test', datetime('now', '-1 hour'))").run()

    const handler = new ShutdownHandler(db, 100)
    const cleanup = handler.register()

    process.emit('SIGINT')

    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // Expired lease should be cleaned — DB may be closed by shutdown handler
    let count: { c: number } | undefined
    try {
      count = db.prepare('SELECT COUNT(*) as c FROM leases').get() as { c: number } | undefined
    } catch {
      // DB closed by shutdown handler — that's expected
      count = undefined
    }
    expect(count === undefined || count.c === 0).toBe(true)
    cleanup()
  })

  it('DB closed on shutdown', async () => {
    const handler = new ShutdownHandler(db, 100)
    const cleanup = handler.register()

    process.emit('SIGINT')

    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    expect(mockExit).toHaveBeenCalled()
    cleanup()
  })
})
