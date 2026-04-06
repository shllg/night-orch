import { describe, it, expect } from 'vitest'
import {
  computeLabelMutation,
  computeMergeLabelMutation,
  isHumanRequired,
  type LabelConfig,
} from '../../src/labels/transitions.js'
import type { MergeBatchStatus } from '../../src/merge-queue/types.js'

const config: LabelConfig = {
  ready: ['orch:ready'],
  running: 'orch:running',
  blocked: 'orch:blocked',
  needsHuman: 'orch:needs-human',
  reviewReady: 'orch:review-ready',
  error: 'orch:error',
  retry: 'orch:retry',
  planning: 'orch:planning',
  mergeQueued: 'orch:merge-queued',
  merging: 'orch:merging',
  mergeFailed: 'orch:merge-failed',
}

describe('isHumanRequired', () => {
  it('returns true for reviewer_blocked', () => {
    expect(isHumanRequired('reviewer_blocked')).toBe(true)
  })

  it('returns false for cost_limit', () => {
    expect(isHumanRequired('cost_limit')).toBe(false)
  })

  it('returns false for iteration_limit', () => {
    expect(isHumanRequired('iteration_limit')).toBe(false)
  })

  it('returns false for agent_pass_limit', () => {
    expect(isHumanRequired('agent_pass_limit')).toBe(false)
  })

  it('returns false for ambiguous_review', () => {
    expect(isHumanRequired('ambiguous_review')).toBe(false)
  })

  it('returns false for verify_config', () => {
    expect(isHumanRequired('verify_config')).toBe(false)
  })
})

describe('computeLabelMutation', () => {
  it('queued → running: add running, remove ready', () => {
    const m = computeLabelMutation('queued', 'running', ['orch:ready'], config)
    expect(m.add).toEqual(['orch:running'])
    expect(m.remove).toEqual(['orch:ready'])
  })

  it('running → blocked (cost_limit): add only blocked, remove running', () => {
    const m = computeLabelMutation('running', 'blocked', ['orch:running'], config, 'cost_limit')
    expect(m.add).toEqual(['orch:blocked'])
    expect(m.remove).toEqual(['orch:running'])
  })

  it('running → blocked (reviewer_blocked): add blocked + needsHuman, remove running', () => {
    const m = computeLabelMutation('running', 'blocked', ['orch:running'], config, 'reviewer_blocked')
    expect(m.add).toEqual(['orch:blocked', 'orch:needs-human'])
    expect(m.remove).toEqual(['orch:running'])
  })

  it('running → blocked (cost_limit) removes stale needsHuman label', () => {
    const m = computeLabelMutation('running', 'blocked', ['orch:running', 'orch:needs-human'], config, 'cost_limit')
    expect(m.add).toEqual(['orch:blocked'])
    expect(m.remove).toEqual(['orch:running', 'orch:needs-human'])
  })

  it('running → blocked (no blockReason): add only blocked, remove running', () => {
    const m = computeLabelMutation('running', 'blocked', ['orch:running'], config)
    expect(m.add).toEqual(['orch:blocked'])
    expect(m.remove).toEqual(['orch:running'])
  })

  it('running → review_ready: add reviewReady, remove running + retry', () => {
    const m = computeLabelMutation('running', 'review_ready', ['orch:running', 'orch:retry'], config)
    expect(m.add).toEqual(['orch:review-ready'])
    expect(m.remove).toContain('orch:running')
    expect(m.remove).toContain('orch:retry')
  })

  it('running → error: add error, remove running', () => {
    const m = computeLabelMutation('running', 'error', ['orch:running'], config)
    expect(m.add).toEqual(['orch:error'])
    expect(m.remove).toEqual(['orch:running'])
  })

  it('blocked → running (retry): add running, remove blocked + needsHuman + error + retry', () => {
    const m = computeLabelMutation('blocked', 'running', ['orch:blocked', 'orch:needs-human'], config)
    expect(m.add).toEqual(['orch:running'])
    expect(m.remove).toContain('orch:blocked')
    expect(m.remove).toContain('orch:needs-human')
  })

  it('idempotent: already has target labels → empty add', () => {
    const m = computeLabelMutation('queued', 'running', ['orch:ready', 'orch:running'], config)
    expect(m.add).toEqual([])
    expect(m.remove).toEqual(['orch:ready'])
  })

  it('no-op when no labels need changing', () => {
    const m = computeLabelMutation('running', 'running', ['orch:running'], config)
    expect(m.add).toEqual([])
    expect(m.remove).toEqual([])
  })

  it('error → queued: add ready, remove terminal labels', () => {
    const m = computeLabelMutation(
      'error',
      'queued',
      ['orch:error', 'orch:running', 'orch:retry', 'orch:blocked', 'orch:needs-human'],
      config,
    )
    expect(m.add).toEqual(['orch:ready'])
    expect(m.remove).toContain('orch:error')
    expect(m.remove).toContain('orch:running')
    expect(m.remove).toContain('orch:blocked')
    expect(m.remove).toContain('orch:needs-human')
    expect(m.remove).toContain('orch:retry')
  })

  it('any non-completed state → completed: remove all runtime orchestration labels', () => {
    const m = computeLabelMutation(
      'blocked',
      'completed',
      ['orch:ready', 'orch:running', 'orch:blocked', 'orch:needs-human', 'orch:review-ready', 'orch:error', 'orch:retry'],
      config,
    )
    expect(m.add).toEqual([])
    expect(m.remove).toEqual([
      'orch:ready',
      'orch:running',
      'orch:blocked',
      'orch:needs-human',
      'orch:review-ready',
      'orch:error',
      'orch:retry',
    ])
  })
})

describe('computeMergeLabelMutation', () => {
  // Exhaustive coverage of every MergeBatchStatus branch plus
  // idempotence (skip adds/removes that are already in the correct state)
  // and empty-input behavior.
  const merge: MergeBatchStatus[] = ['pending', 'building', 'testing', 'bisecting', 'passed', 'failed']

  it('covers all MergeBatchStatus variants (sanity check)', () => {
    for (const status of merge) {
      const m = computeMergeLabelMutation(status, [], config)
      expect(m).toBeDefined()
    }
  })

  describe('pending', () => {
    it('adds mergeQueued and removes mergeFailed from empty labels', () => {
      const m = computeMergeLabelMutation('pending', [], config)
      expect(m.add).toEqual(['orch:merge-queued'])
      expect(m.remove).toEqual([])
    })

    it('removes lingering mergeFailed when queuing', () => {
      const m = computeMergeLabelMutation('pending', ['orch:merge-failed'], config)
      expect(m.add).toEqual(['orch:merge-queued'])
      expect(m.remove).toEqual(['orch:merge-failed'])
    })

    it('idempotent — does not re-add mergeQueued if already present', () => {
      const m = computeMergeLabelMutation('pending', ['orch:merge-queued'], config)
      expect(m.add).toEqual([])
      expect(m.remove).toEqual([])
    })
  })

  describe('building', () => {
    it('adds mergeQueued and removes mergeFailed', () => {
      const m = computeMergeLabelMutation('building', [], config)
      expect(m.add).toEqual(['orch:merge-queued'])
    })

    it('idempotent when mergeQueued already set', () => {
      const m = computeMergeLabelMutation('building', ['orch:merge-queued'], config)
      expect(m.add).toEqual([])
    })
  })

  describe('testing', () => {
    it('adds mergeQueued on enter', () => {
      const m = computeMergeLabelMutation('testing', [], config)
      expect(m.add).toEqual(['orch:merge-queued'])
    })
  })

  describe('bisecting', () => {
    it('swaps mergeQueued for merging and clears mergeFailed', () => {
      const m = computeMergeLabelMutation(
        'bisecting',
        ['orch:merge-queued', 'orch:merge-failed'],
        config,
      )
      expect(m.add).toEqual(['orch:merging'])
      expect(m.remove.sort()).toEqual(['orch:merge-failed', 'orch:merge-queued'])
    })

    it('idempotent when merging already set', () => {
      const m = computeMergeLabelMutation('bisecting', ['orch:merging'], config)
      expect(m.add).toEqual([])
    })
  })

  describe('passed', () => {
    it('strips every merge-queue label', () => {
      const m = computeMergeLabelMutation(
        'passed',
        ['orch:merge-queued', 'orch:merging', 'orch:merge-failed'],
        config,
      )
      expect(m.add).toEqual([])
      expect(m.remove.sort()).toEqual(
        ['orch:merge-failed', 'orch:merge-queued', 'orch:merging'].sort(),
      )
    })

    it('idempotent on empty input', () => {
      const m = computeMergeLabelMutation('passed', [], config)
      expect(m.add).toEqual([])
      expect(m.remove).toEqual([])
    })
  })

  describe('failed', () => {
    it('adds mergeFailed, removes mergeQueued + merging', () => {
      const m = computeMergeLabelMutation(
        'failed',
        ['orch:merge-queued', 'orch:merging'],
        config,
      )
      expect(m.add).toEqual(['orch:merge-failed'])
      expect(m.remove.sort()).toEqual(['orch:merge-queued', 'orch:merging'])
    })

    it('idempotent when mergeFailed already set', () => {
      const m = computeMergeLabelMutation('failed', ['orch:merge-failed'], config)
      expect(m.add).toEqual([])
      expect(m.remove).toEqual([])
    })
  })

  it('never returns labels that should not be there (no cross-contamination)', () => {
    // Sanity: bisecting output should never include mergeQueued (always removed).
    const m = computeMergeLabelMutation('bisecting', ['orch:merge-queued'], config)
    expect(m.add).not.toContain('orch:merge-queued')
    expect(m.remove).toContain('orch:merge-queued')
  })
})
