import { describe, it, expect } from 'vitest'
import { parsePortRange, allocatePort } from '../../src/environment/port.js'

describe('parsePortRange', () => {
  it('parses valid range', () => {
    expect(parsePortRange('{auto:5101-5199}')).toEqual({ min: 5101, max: 5199 })
  })

  it('returns null for non-range string', () => {
    expect(parsePortRange('3000')).toBeNull()
    expect(parsePortRange('{manual:5000}')).toBeNull()
  })
})

describe('allocatePort', () => {
  it('returns first port when none used', () => {
    expect(allocatePort({ min: 5000, max: 5010 }, [])).toBe(5000)
  })

  it('skips used ports', () => {
    expect(allocatePort({ min: 5000, max: 5010 }, [5000, 5001])).toBe(5002)
  })

  it('throws when range exhausted', () => {
    expect(() => allocatePort({ min: 5000, max: 5001 }, [5000, 5001])).toThrow(/exhausted/)
  })
})
