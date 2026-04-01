import { describe, expect, it } from 'vitest'
import {
  colorForCostUsd,
  colorForIterationCount,
  colorForPhase,
  colorForPrNumber,
  colorForRunStatus,
} from '../../../src/cli/tui/constants.js'

describe('tui semantic color helpers', () => {
  it('maps run statuses with a safe fallback', () => {
    expect(colorForRunStatus('running')).toBe('yellow')
    expect(colorForRunStatus('queued')).toBe('cyan')
    expect(colorForRunStatus('review_ready')).toBe('magenta')
    expect(colorForRunStatus('unknown')).toBe('white')
  })

  it('maps phases by direct match, token match, heuristic, and fallback', () => {
    expect(colorForPhase(null)).toBe('gray')
    expect(colorForPhase('  ')).toBe('gray')
    expect(colorForPhase('review')).toBe('magenta')
    expect(colorForPhase('phase:verify_checks')).toBe('green')
    expect(colorForPhase('blocked_by_ci')).toBe('red')
    expect(colorForPhase('waiting_for_approval')).toBe('cyan')
    expect(colorForPhase('implement_fix')).toBe('yellow')
    expect(colorForPhase('release_candidate')).toBe('green')
    expect(colorForPhase('mystery_phase')).toBe('white')
  })

  it('maps iteration count thresholds', () => {
    expect(colorForIterationCount(null)).toBe('green')
    expect(colorForIterationCount(1)).toBe('green')
    expect(colorForIterationCount(2)).toBe('yellow')
    expect(colorForIterationCount(3)).toBe('red')
  })

  it('maps cost thresholds', () => {
    expect(colorForCostUsd(null)).toBe('gray')
    expect(colorForCostUsd(0)).toBe('gray')
    expect(colorForCostUsd(0.49)).toBe('green')
    expect(colorForCostUsd(0.5)).toBe('yellow')
    expect(colorForCostUsd(1.99)).toBe('yellow')
    expect(colorForCostUsd(2)).toBe('red')
  })

  it('maps PR number presence', () => {
    expect(colorForPrNumber(undefined)).toBe('gray')
    expect(colorForPrNumber(null)).toBe('gray')
    expect(colorForPrNumber(123)).toBe('cyan')
  })
})
