import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { allocatePort, isPortFree } from '../../src/environment/port.js'

/** Bind an ephemeral port and return it + a closer, to simulate a busy port. */
function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen({ port: 0, host: '0.0.0.0' }, () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('no address'))
        return
      }
      resolve({
        port: addr.port,
        release: () => new Promise((res) => srv.close(() => res())),
      })
    })
  })
}

describe('isPortFree', () => {
  it('returns false for a port currently bound', async () => {
    const held = await holdPort()
    try {
      expect(await isPortFree(held.port)).toBe(false)
    } finally {
      await held.release()
    }
  })

  it('returns true for a freed port', async () => {
    const held = await holdPort()
    const { port } = held
    await held.release()
    expect(await isPortFree(port)).toBe(true)
  })
})

describe('allocatePort', () => {
  it('returns first port when none used and range is free', async () => {
    // Use a high range unlikely to be occupied on the test host.
    const port = await allocatePort({ min: 49210, max: 49219 }, [])
    expect(port).toBeGreaterThanOrEqual(49210)
    expect(port).toBeLessThanOrEqual(49219)
  })

  it('skips ports already in the used set', async () => {
    const used = [49230, 49231]
    const port = await allocatePort({ min: 49230, max: 49239 }, used)
    expect(port).toBeGreaterThanOrEqual(49232)
    expect(used).toContain(port)
  })

  it('skips a port that is host-bound even when not in the used set', async () => {
    const held = await holdPort()
    try {
      // Force the range to start at the held port; allocator must skip it.
      const port = await allocatePort({ min: held.port, max: held.port + 5 }, [])
      expect(port).not.toBe(held.port)
    } finally {
      await held.release()
    }
  })

  it('throws when the whole range is in use', async () => {
    await expect(allocatePort({ min: 49250, max: 49251 }, [49250, 49251])).rejects.toThrow(/exhausted/)
  })

  it('throws when the whole range is host-bound', async () => {
    const a = await holdPort()
    // Build a 1-wide range on the held port; nothing else to try.
    try {
      await expect(allocatePort({ min: a.port, max: a.port }, [])).rejects.toThrow(/exhausted/)
    } finally {
      await a.release()
    }
  })

  it('hands out distinct ports under concurrent allocation on a shared set (no duplicates)', async () => {
    const used: number[] = []
    const range = { min: 49300, max: 49399 }
    const results = await Promise.all(
      Array.from({ length: 10 }, () => allocatePort(range, used)),
    )
    expect(new Set(results).size).toBe(results.length) // all distinct
    expect(used.length).toBe(results.length)
  })
})
