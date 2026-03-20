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
})
