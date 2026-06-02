import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../../src/utils/concurrency.js'

describe('mapWithConcurrency', () => {
  it('bounds peak concurrency to the limit and preserves order', async () => {
    let active = 0
    let peak = 0

    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return n * 2
    })

    expect(peak).toBeLessThanOrEqual(2)
    expect(result).toEqual([2, 4, 6, 8, 10, 12])
  })

  it('returns an empty array for empty input', async () => {
    expect(await mapWithConcurrency<number, number>([], 4, async (n) => n)).toEqual([])
  })
})
