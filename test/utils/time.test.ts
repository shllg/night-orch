import { describe, expect, it } from 'vitest'
import {
  formatUtcClock,
  formatUtcDateTime,
  parseUtcTimestampMs,
  utcDayKey,
} from '../../src/utils/time.js'

describe('time utils', () => {
  it('parses sqlite timestamps as UTC', () => {
    const parsed = parseUtcTimestampMs('2026-04-01 10:15:30')
    expect(Number.isFinite(parsed)).toBe(true)
    expect(new Date(parsed).toISOString()).toBe('2026-04-01T10:15:30.000Z')
  })

  it('parses ISO timestamps without timezone as UTC', () => {
    const parsed = parseUtcTimestampMs('2026-04-01T10:15:30')
    expect(Number.isFinite(parsed)).toBe(true)
    expect(new Date(parsed).toISOString()).toBe('2026-04-01T10:15:30.000Z')
  })

  it('formats clock display with explicit UTC label', () => {
    expect(formatUtcClock('2026-04-01T10:15:30.000Z')).toBe('10:15:30 UTC')
  })

  it('formats full datetime display with explicit UTC label', () => {
    expect(formatUtcDateTime('2026-04-01 10:15:30')).toBe('2026-04-01 10:15:30 UTC')
  })

  it('returns invalid markers for unparsable values', () => {
    expect(formatUtcClock('not-a-time')).toBe('--:--:-- UTC')
    expect(formatUtcDateTime('not-a-time')).toBe('invalid UTC timestamp')
  })

  it('extracts UTC day key from ISO string', () => {
    expect(utcDayKey('2026-04-01T10:15:30.000Z')).toBe('2026-04-01')
  })
})
