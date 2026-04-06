import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LeaseManager } from '../../src/state/leases.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

describe('LeaseManager', () => {
  let tmpDir: string
  let db: Database.Database
  let leaseManager: LeaseManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-lease-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    leaseManager = new LeaseManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('acquires a lease on uncontested issue', () => {
    const result = leaseManager.acquire('org/repo', 1, 'runner-1', 3600)
    expect(result).toBe(true)
  })

  it('fails to acquire if already leased', () => {
    leaseManager.acquire('org/repo', 1, 'runner-1', 3600)
    const result = leaseManager.acquire('org/repo', 1, 'runner-2', 3600)
    expect(result).toBe(false)
  })

  it('succeeds if previous lease expired', () => {
    // Insert an already-expired lease directly
    db.prepare(
      "INSERT INTO leases (repo, issue_number, lease_owner, leased_until) VALUES (?, ?, ?, datetime('now', '-1 seconds'))",
    ).run('org/repo', 1, 'runner-1')

    const result = leaseManager.acquire('org/repo', 1, 'runner-2', 3600)
    expect(result).toBe(true)
  })

  it('isLeased returns true for active lease', () => {
    leaseManager.acquire('org/repo', 1, 'runner-1', 3600)
    expect(leaseManager.isLeased('org/repo', 1)).toBe(true)
  })

  it('isLeased returns false for no lease', () => {
    expect(leaseManager.isLeased('org/repo', 1)).toBe(false)
  })

  it('release makes issue available', () => {
    leaseManager.acquire('org/repo', 1, 'runner-1', 3600)
    leaseManager.release('org/repo', 1)
    expect(leaseManager.isLeased('org/repo', 1)).toBe(false)

    // Can re-acquire
    const result = leaseManager.acquire('org/repo', 1, 'runner-2', 3600)
    expect(result).toBe(true)
  })

  it('release is idempotent', () => {
    leaseManager.release('org/repo', 99) // no lease exists — no error
  })

  it('cleanExpired removes only expired leases', () => {
    // Active lease
    leaseManager.acquire('org/repo', 1, 'runner-1', 3600)

    // Expired lease
    db.prepare(
      "INSERT INTO leases (repo, issue_number, lease_owner, leased_until) VALUES (?, ?, ?, datetime('now', '-1 seconds'))",
    ).run('org/repo', 2, 'runner-1')

    const cleaned = leaseManager.cleanExpired()
    expect(cleaned).toBe(1)
    expect(leaseManager.isLeased('org/repo', 1)).toBe(true)
    expect(leaseManager.isLeased('org/repo', 2)).toBe(false)
  })

  it('different repos are independent', () => {
    leaseManager.acquire('org/repo-a', 1, 'runner-1', 3600)
    const result = leaseManager.acquire('org/repo-b', 1, 'runner-1', 3600)
    expect(result).toBe(true)
  })

  it('releaseAll clears all active leases', () => {
    leaseManager.acquire('org/repo-a', 1, 'runner-1', 3600)
    leaseManager.acquire('org/repo-b', 2, 'runner-2', 3600)
    const removed = leaseManager.releaseAll()
    expect(removed).toBe(2)
    expect(leaseManager.isLeased('org/repo-a', 1)).toBe(false)
    expect(leaseManager.isLeased('org/repo-b', 2)).toBe(false)
  })

  it('releaseAll(owner) clears only matching owner leases', () => {
    leaseManager.acquire('org/repo-a', 1, 'runner-1', 3600)
    leaseManager.acquire('org/repo-b', 2, 'runner-2', 3600)
    const removed = leaseManager.releaseAll('runner-1')
    expect(removed).toBe(1)
    expect(leaseManager.isLeased('org/repo-a', 1)).toBe(false)
    expect(leaseManager.isLeased('org/repo-b', 2)).toBe(true)
  })

  describe('heartbeat', () => {
    it('returns true for a live owner-held lease and extends the deadline', () => {
      // Acquire with a short 2-second window then heartbeat to 3600.
      leaseManager.acquire('org/repo', 1, 'runner-1', 2)
      const held = leaseManager.heartbeat('org/repo', 1, 'runner-1', 3600)
      expect(held).toBe(true)
      // Confirm the lease survives well past the original 2-second window.
      const row = db
        .prepare("SELECT leased_until FROM leases WHERE repo = 'org/repo' AND issue_number = 1")
        .get() as { leased_until: string } | undefined
      expect(row).toBeDefined()
      // The deadline should be more than 30 minutes from now (we asked for 3600s).
      const deadline = new Date(row!.leased_until.replace(' ', 'T') + 'Z').getTime()
      expect(deadline - Date.now()).toBeGreaterThan(30 * 60 * 1000)
    })

    it('returns false for a lease owned by someone else', () => {
      leaseManager.acquire('org/repo', 1, 'runner-1', 3600)
      const held = leaseManager.heartbeat('org/repo', 1, 'runner-2', 3600)
      expect(held).toBe(false)
    })

    it('returns false when no lease exists', () => {
      const held = leaseManager.heartbeat('org/repo', 999, 'runner-1', 3600)
      expect(held).toBe(false)
    })
  })
})
