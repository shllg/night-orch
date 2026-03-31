import { describe, it, expect } from 'vitest'
import { bisectBatch, isCulpritIdentified } from '../../src/merge-queue/bisect.js'

describe('bisectBatch', () => {
  it('splits batch of 2 into two singles', () => {
    const [left, right] = bisectBatch([1, 2])
    expect(left).toEqual([1])
    expect(right).toEqual([2])
  })

  it('splits batch of 3 into [2, 1]', () => {
    const [left, right] = bisectBatch([1, 2, 3])
    expect(left).toEqual([1, 2])
    expect(right).toEqual([3])
  })

  it('splits batch of 4 into [2, 2]', () => {
    const [left, right] = bisectBatch([1, 2, 3, 4])
    expect(left).toEqual([1, 2])
    expect(right).toEqual([3, 4])
  })

  it('splits batch of 5 into [3, 2]', () => {
    const [left, right] = bisectBatch([10, 20, 30, 40, 50])
    expect(left).toEqual([10, 20, 30])
    expect(right).toEqual([40, 50])
  })

  it('preserves original PR numbers unchanged', () => {
    const input = [101, 202, 303, 404, 505, 606]
    const [left, right] = bisectBatch(input)
    expect([...left, ...right]).toEqual(input)
  })

  it('throws for single-item batch', () => {
    expect(() => bisectBatch([1])).toThrow('Cannot bisect')
  })

  it('throws for empty batch', () => {
    expect(() => bisectBatch([])).toThrow('Cannot bisect')
  })
})

describe('isCulpritIdentified', () => {
  it('returns true for single PR', () => {
    expect(isCulpritIdentified([42])).toBe(true)
  })

  it('returns false for multiple PRs', () => {
    expect(isCulpritIdentified([1, 2])).toBe(false)
  })

  it('returns false for empty array', () => {
    expect(isCulpritIdentified([])).toBe(false)
  })
})
