import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MergeBatchManager } from '../../src/merge-queue/batch.js'
import { initDatabase } from '../../src/state/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

describe('MergeBatchManager', () => {
  let tmpDir: string
  let db: Database.Database
  let manager: MergeBatchManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-batch-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    manager = new MergeBatchManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('create', () => {
    it('creates a batch with generated ID and pending status', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1, 2, 3],
        approvedShas: ['sha1', 'sha2'],
      })

      expect(batch.id).toMatch(/^batch-/)
      expect(batch.repo).toBe('org/repo')
      expect(batch.baseBranch).toBe('main')
      expect(batch.baseSha).toBe('abc123')
      expect(batch.status).toBe('pending')
      expect(batch.stagingBranch).toBeNull()
      expect(batch.stagingSha).toBeNull()
      expect(batch.retryCount).toBe(0)
      expect(batch.parentBatchId).toBeNull()
    })

    it('serializes and deserializes prNumbers correctly', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [10, 20, 30],
        approvedShas: [],
      })

      const fetched = manager.getById(batch.id)
      expect(fetched?.prNumbers).toEqual([10, 20, 30])
    })

    it('serializes and deserializes approvedShas correctly', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [],
        approvedShas: ['deadbeef', 'cafebabe', '12345678'],
      })

      const fetched = manager.getById(batch.id)
      expect(fetched?.approvedShas).toEqual(['deadbeef', 'cafebabe', '12345678'])
    })

    it('handles empty prNumbers and approvedShas', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [],
        approvedShas: [],
      })

      const fetched = manager.getById(batch.id)
      expect(fetched?.prNumbers).toEqual([])
      expect(fetched?.approvedShas).toEqual([])
    })
  })

  describe('getById', () => {
    it('returns null for a non-existent ID', () => {
      expect(manager.getById('batch-nonexistent')).toBeNull()
    })

    it('returns the batch for a valid ID', () => {
      const created = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })

      const fetched = manager.getById(created.id)
      expect(fetched).not.toBeNull()
      expect(fetched?.id).toBe(created.id)
    })
  })

  describe('getActiveBatch', () => {
    it('returns null when no batches exist', () => {
      expect(manager.getActiveBatch('org/repo')).toBeNull()
    })

    it('returns a pending batch as the active batch', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })

      const active = manager.getActiveBatch('org/repo')
      expect(active?.id).toBe(batch.id)
    })

    it('returns null when all batches are in terminal states', () => {
      const b1 = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })
      const b2 = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [2],
        approvedShas: [],
      })
      manager.update(b1.id, { status: 'passed' })
      manager.update(b2.id, { status: 'failed' })

      expect(manager.getActiveBatch('org/repo')).toBeNull()
    })

    it('returns non-terminal batch when mixed terminal and non-terminal exist', () => {
      const passed = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })
      const active = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [2],
        approvedShas: [],
      })
      manager.update(passed.id, { status: 'passed' })

      const result = manager.getActiveBatch('org/repo')
      expect(result?.id).toBe(active.id)
    })

    it('does not return batches from a different repo', () => {
      manager.create({
        repo: 'org/other-repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })

      expect(manager.getActiveBatch('org/repo')).toBeNull()
    })

    it('returns the earliest-created batch when multiple non-terminal exist', () => {
      const first = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'sha1',
        prNumbers: [1],
        approvedShas: [],
      })
      manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'sha2',
        prNumbers: [2],
        approvedShas: [],
      })

      const active = manager.getActiveBatch('org/repo')
      expect(active?.id).toBe(first.id)
    })
  })

  describe('getByRepoAndStatus', () => {
    it('returns only batches matching repo and status', () => {
      const b1 = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'sha1',
        prNumbers: [1],
        approvedShas: [],
      })
      const b2 = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'sha2',
        prNumbers: [2],
        approvedShas: [],
      })
      manager.update(b2.id, { status: 'building' })

      // Create one in a different repo
      manager.create({
        repo: 'org/other',
        baseBranch: 'main',
        baseSha: 'sha3',
        prNumbers: [3],
        approvedShas: [],
      })

      const pending = manager.getByRepoAndStatus('org/repo', 'pending')
      expect(pending).toHaveLength(1)
      expect(pending[0]?.id).toBe(b1.id)

      const building = manager.getByRepoAndStatus('org/repo', 'building')
      expect(building).toHaveLength(1)
      expect(building[0]?.id).toBe(b2.id)
    })

    it('returns empty array when no match', () => {
      expect(manager.getByRepoAndStatus('org/repo', 'passed')).toEqual([])
    })
  })

  describe('update', () => {
    it('updates status', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })

      manager.update(batch.id, { status: 'building' })

      const updated = manager.getById(batch.id)
      expect(updated?.status).toBe('building')
    })

    it('updates stagingBranch and stagingSha', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })

      manager.update(batch.id, {
        stagingBranch: 'orch/staging/batch-xyz',
        stagingSha: 'deadbeef',
      })

      const updated = manager.getById(batch.id)
      expect(updated?.stagingBranch).toBe('orch/staging/batch-xyz')
      expect(updated?.stagingSha).toBe('deadbeef')
    })

    it('updates retryCount', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })

      manager.update(batch.id, { retryCount: 2 })

      const updated = manager.getById(batch.id)
      expect(updated?.retryCount).toBe(2)
    })

    it('updates parentBatchId', () => {
      const parent = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1, 2],
        approvedShas: [],
      })
      const child = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })

      manager.update(child.id, { parentBatchId: parent.id })

      const updated = manager.getById(child.id)
      expect(updated?.parentBatchId).toBe(parent.id)
    })

    it('is a no-op when no fields are provided', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })

      // Should not throw
      manager.update(batch.id, {})

      const unchanged = manager.getById(batch.id)
      expect(unchanged?.status).toBe('pending')
    })

    it('throws on unknown update field keys', () => {
      const batch = manager.create({
        repo: 'org/repo',
        baseBranch: 'main',
        baseSha: 'abc123',
        prNumbers: [1],
        approvedShas: [],
      })

      expect(() => manager.update(batch.id, { unknownField: 'x' } as unknown as Parameters<typeof manager.update>[1]))
        .toThrow('Unknown merge batch field: unknownField')
    })
  })

  describe('JSON parsing', () => {
    it('handles malformed JSON arrays safely', () => {
      db.prepare(
        `INSERT INTO merge_batches (id, repo, base_branch, base_sha, status, pr_numbers, approved_shas)
         VALUES ('batch-bad-json', 'org/repo', 'main', 'abc123', 'pending', '{bad', '{also-bad')`,
      ).run()

      const batch = manager.getById('batch-bad-json')
      expect(batch?.prNumbers).toEqual([])
      expect(batch?.approvedShas).toEqual([])
    })
  })
})
