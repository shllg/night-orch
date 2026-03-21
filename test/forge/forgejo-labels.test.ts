import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LabelCache } from '../../src/forge/forgejo-labels.js'
import type { ForgejoClient } from '../../src/forge/forgejo-client.js'

function makeMockClient(): ForgejoClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    getPaginated: vi.fn(),
  } as unknown as ForgejoClient
}

const LABELS = [
  { id: 1, name: 'bug' },
  { id: 2, name: 'enhancement' },
  { id: 3, name: 'orch:ready' },
]

describe('LabelCache', () => {
  let client: ForgejoClient
  let cache: LabelCache

  beforeEach(() => {
    client = makeMockClient()
    cache = new LabelCache(client)
    vi.mocked(client.getPaginated).mockResolvedValue(LABELS)
  })

  describe('getIdByName', () => {
    it('fetches labels from API on first call', async () => {
      const id = await cache.getIdByName('org/repo', 'bug')

      expect(id).toBe(1)
      expect(client.getPaginated).toHaveBeenCalledWith('/repos/org/repo/labels')
    })

    it('uses cache for subsequent calls', async () => {
      await cache.getIdByName('org/repo', 'bug')
      await cache.getIdByName('org/repo', 'enhancement')

      expect(client.getPaginated).toHaveBeenCalledTimes(1)
    })

    it('returns null for unknown label name', async () => {
      const id = await cache.getIdByName('org/repo', 'nonexistent')

      expect(id).toBeNull()
    })

    it('caches per repo separately', async () => {
      const otherLabels = [{ id: 10, name: 'bug' }]
      vi.mocked(client.getPaginated)
        .mockResolvedValueOnce(LABELS)
        .mockResolvedValueOnce(otherLabels)

      const id1 = await cache.getIdByName('org/repo', 'bug')
      const id2 = await cache.getIdByName('org/other', 'bug')

      expect(id1).toBe(1)
      expect(id2).toBe(10)
      expect(client.getPaginated).toHaveBeenCalledTimes(2)
    })
  })

  describe('getIdsByNames', () => {
    it('resolves multiple names at once', async () => {
      const ids = await cache.getIdsByNames('org/repo', ['bug', 'enhancement', 'nonexistent'])

      expect(ids).toEqual([1, 2, null])
    })
  })

  describe('invalidate', () => {
    it('forces re-fetch on next access', async () => {
      await cache.getIdByName('org/repo', 'bug')
      expect(client.getPaginated).toHaveBeenCalledTimes(1)

      cache.invalidate('org/repo')

      await cache.getIdByName('org/repo', 'bug')
      expect(client.getPaginated).toHaveBeenCalledTimes(2)
    })

    it('does not affect other repos', async () => {
      await cache.getIdByName('org/repo', 'bug')
      await cache.getIdByName('org/other', 'bug')

      cache.invalidate('org/repo')

      await cache.getIdByName('org/other', 'bug')
      // org/other should still be cached (2 total calls, not 3)
      expect(client.getPaginated).toHaveBeenCalledTimes(2)
    })
  })

  describe('concurrent access', () => {
    it('deduplicates concurrent fetches for the same repo', async () => {
      // Slow response to simulate concurrency
      vi.mocked(client.getPaginated).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(LABELS), 10)),
      )

      const [id1, id2] = await Promise.all([
        cache.getIdByName('org/repo', 'bug'),
        cache.getIdByName('org/repo', 'enhancement'),
      ])

      expect(id1).toBe(1)
      expect(id2).toBe(2)
      expect(client.getPaginated).toHaveBeenCalledTimes(1)
    })
  })

  describe('error handling', () => {
    it('throws on invalid repo format', async () => {
      await expect(cache.getIdByName('invalid', 'bug')).rejects.toThrow('Invalid repo format')
    })
  })
})
