import { describe, expect, it } from 'vitest'
import {
  STATUS_BADGE_TONE,
  badgeToneForCostUsd,
  badgeToneForIterationCount,
  badgeToneForPhase,
  badgeToneForPrNumber,
} from '../../web/src/lib/run-tone.js'

describe('web run tone helpers', () => {
  it('maps run statuses to expected badge tones', () => {
    expect(STATUS_BADGE_TONE.running).toBe('badge-warning')
    expect(STATUS_BADGE_TONE.queued).toBe('badge-info')
    expect(STATUS_BADGE_TONE.review_ready).toBe('badge-secondary')
    expect(STATUS_BADGE_TONE.completed).toBe('badge-success')
    expect(STATUS_BADGE_TONE.blocked).toBe('badge-error')
    expect(STATUS_BADGE_TONE.error).toBe('badge-error')
  })

  it('resolves phase tones from direct and inferred phase names', () => {
    expect(badgeToneForPhase(null)).toBe('badge-neutral')
    expect(badgeToneForPhase('review')).toBe('badge-secondary')
    expect(badgeToneForPhase('phase:verify_checks')).toBe('badge-success')
    expect(badgeToneForPhase('blocked_by_ci')).toBe('badge-error')
    expect(badgeToneForPhase('waiting_for_approval')).toBe('badge-info')
    expect(badgeToneForPhase('implement_fix')).toBe('badge-warning')
    expect(badgeToneForPhase('release_candidate')).toBe('badge-success')
    expect(badgeToneForPhase('mystery_phase')).toBe('badge-ghost')
  })

  it('colors iteration and cost thresholds like TUI', () => {
    expect(badgeToneForIterationCount(null)).toBe('badge-success')
    expect(badgeToneForIterationCount(1)).toBe('badge-success')
    expect(badgeToneForIterationCount(2)).toBe('badge-warning')
    expect(badgeToneForIterationCount(3)).toBe('badge-error')

    expect(badgeToneForCostUsd(null)).toBe('badge-neutral')
    expect(badgeToneForCostUsd(0)).toBe('badge-neutral')
    expect(badgeToneForCostUsd(0.49)).toBe('badge-success')
    expect(badgeToneForCostUsd(0.5)).toBe('badge-warning')
    expect(badgeToneForCostUsd(1.99)).toBe('badge-warning')
    expect(badgeToneForCostUsd(2)).toBe('badge-error')
  })

  it('colors PR presence', () => {
    expect(badgeToneForPrNumber(undefined)).toBe('badge-neutral')
    expect(badgeToneForPrNumber(null)).toBe('badge-neutral')
    expect(badgeToneForPrNumber(123)).toBe('badge-info')
  })
})
