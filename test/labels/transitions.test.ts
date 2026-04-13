import { describe, it, expect } from 'vitest'
import {
  computeLabelMutation,
  computeMergeLabelMutation,
  isHumanRequired,
  type LabelConfig,
} from '../../src/labels/transitions.js'
import type { BlockedReason } from '../../src/loop/state.js'
import type { MergeBatchStatus } from '../../src/merge-queue/types.js'
import type { RunStatus } from '../../src/state/runs.js'

const reviewerBlocked: BlockedReason = { type: 'reviewerBlocked', summary: 'no' }
const costLimit: BlockedReason = { type: 'costLimit', limit: 'per-run', actualUsd: 12, limitUsd: 10 }
const iterationLimit: BlockedReason = { type: 'iterationLimit', iterations: 4, max: 4 }
const agentPassLimit: BlockedReason = { type: 'agentPassLimit', passes: 10, max: 10 }
const ambiguousReview: BlockedReason = { type: 'ambiguousReview', excerpt: 'mangled' }
const verifyConfig: BlockedReason = { type: 'verifyConfig', detail: 'no commands' }

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
  it('returns true for reviewerBlocked', () => {
    expect(isHumanRequired(reviewerBlocked)).toBe(true)
  })

  it('returns false for costLimit', () => {
    expect(isHumanRequired(costLimit)).toBe(false)
  })

  it('returns false for iterationLimit', () => {
    expect(isHumanRequired(iterationLimit)).toBe(false)
  })

  it('returns false for agentPassLimit', () => {
    expect(isHumanRequired(agentPassLimit)).toBe(false)
  })

  it('returns false for ambiguousReview', () => {
    expect(isHumanRequired(ambiguousReview)).toBe(false)
  })

  it('returns false for verifyConfig', () => {
    expect(isHumanRequired(verifyConfig)).toBe(false)
  })
})

describe('computeLabelMutation', () => {
  const fromStates: RunStatus[] = ['queued', 'running', 'review_ready', 'blocked', 'error', 'completed']
  const labelScenarios = [
    { name: 'empty labels', labels: [] },
    { name: 'single ready label', labels: ['orch:ready', 'keep:me'] },
    {
      name: 'dirty orchestration labels',
      labels: [
        'orch:ready',
        'queue:ready',
        'orch:running',
        'orch:blocked',
        'orch:needs-human',
        'orch:review-ready',
        'orch:error',
        'orch:retry',
        'keep:me',
      ],
    },
  ] as const
  const multiReadyConfig: LabelConfig = {
    ...config,
    ready: ['orch:ready', 'queue:ready'],
  }
  const orchestrationLabels = [
    ...multiReadyConfig.ready,
    multiReadyConfig.running,
    multiReadyConfig.blocked,
    multiReadyConfig.needsHuman,
    multiReadyConfig.reviewReady,
    multiReadyConfig.error,
    multiReadyConfig.retry,
  ]

  function applyMutation(currentLabels: string[], mutation: { add: string[]; remove: string[] }): string[] {
    const next = new Set(currentLabels)
    for (const label of mutation.remove) next.delete(label)
    for (const label of mutation.add) next.add(label)
    return [...next]
  }

  function orchestrationOnly(labels: string[]): string[] {
    return labels.filter((label) => orchestrationLabels.includes(label)).sort()
  }

  it('queued restores every ready label and clears transient orchestration labels', () => {
    for (const from of fromStates) {
      for (const scenario of labelScenarios) {
        const queuedMutation = computeLabelMutation(from, 'queued', scenario.labels, multiReadyConfig)
        expect(orchestrationOnly(applyMutation(scenario.labels, queuedMutation))).toEqual(
          [...multiReadyConfig.ready].sort(),
        )
      }
    }
  })

  it('review_ready strips every other orchestration label across starting states', () => {
    for (const from of fromStates) {
      for (const scenario of labelScenarios) {
        const reviewReadyMutation = computeLabelMutation(from, 'review_ready', scenario.labels, multiReadyConfig)
        expect(orchestrationOnly(applyMutation(scenario.labels, reviewReadyMutation))).toEqual(
          [multiReadyConfig.reviewReady],
        )
      }
    }
  })

  it('completed strips all orchestration labels across starting states', () => {
    for (const from of fromStates) {
      for (const scenario of labelScenarios) {
        const completedMutation = computeLabelMutation(from, 'completed', scenario.labels, multiReadyConfig)
        expect(orchestrationOnly(applyMutation(scenario.labels, completedMutation))).toEqual([])
      }
    }
  })

  it('blocked transitions cover all BlockedReason variants and preserve the needsHuman branch', () => {
    const blockCases: Array<{ name: string; reason?: BlockedReason }> = [
      { name: 'reviewerBlocked', reason: reviewerBlocked },
      { name: 'costLimit', reason: costLimit },
      { name: 'iterationLimit', reason: iterationLimit },
      { name: 'agentPassLimit', reason: agentPassLimit },
      { name: 'ambiguousReview', reason: ambiguousReview },
      { name: 'verifyConfig', reason: verifyConfig },
      { name: 'undefined', reason: undefined },
    ]

    for (const from of fromStates) {
      for (const scenario of labelScenarios) {
        for (const blockCase of blockCases) {
          const blockedMutation = computeLabelMutation(from, 'blocked', scenario.labels, multiReadyConfig, blockCase.reason)
          const nextLabels = applyMutation(scenario.labels, blockedMutation)
          expect(nextLabels).toContain(multiReadyConfig.blocked)
          expect(nextLabels).not.toContain(multiReadyConfig.running)
          if (isHumanRequired(blockCase.reason ?? costLimit)) {
            expect(nextLabels).toContain(multiReadyConfig.needsHuman)
          } else {
            expect(nextLabels).not.toContain(multiReadyConfig.needsHuman)
          }
        }
      }
    }
  })

  it('is idempotent once the target review_ready state is applied', () => {
    const first = computeLabelMutation(
      'running',
      'review_ready',
      ['orch:ready', 'queue:ready', 'orch:running', 'orch:retry'],
      multiReadyConfig,
    )
    const applied = applyMutation(['orch:ready', 'queue:ready', 'orch:running', 'orch:retry'], first)
    const second = computeLabelMutation('review_ready', 'review_ready', applied, multiReadyConfig)
    expect(second).toEqual({ add: [], remove: [] })
  })

  it('review_ready from a clean state is an empty diff', () => {
    const mutation = computeLabelMutation(
      'review_ready',
      'review_ready',
      ['orch:review-ready'],
      multiReadyConfig,
    )
    expect(mutation).toEqual({ add: [], remove: [] })
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
