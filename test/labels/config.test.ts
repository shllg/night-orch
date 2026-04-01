import { describe, it, expect } from 'vitest'
import { buildLabelConfig, getDiscoveryIncludeLabels, isKanbanIssue } from '../../src/labels/config.js'

describe('label flow config', () => {
  const repoConfig = {
    labels: {
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
    },
    selectors: {
      includeLabelsAny: ['orch:ready'],
      excludeLabelsAny: [],
    },
    kanban: {
      triggerLabel: 'flow:kanban',
      labels: {
        ready: ['kanban:todo'],
        running: 'kanban:doing',
        blocked: 'kanban:blocked',
        needsHuman: 'kanban:needs-human',
        reviewReady: 'kanban:review',
        error: 'kanban:error',
        retry: 'kanban:retry',
        planning: 'kanban:planning',
        mergeQueued: 'kanban:merge-queued',
        merging: 'kanban:merging',
        mergeFailed: 'kanban:merge-failed',
      },
    },
  }

  it('uses default labels when kanban trigger is absent', () => {
    const result = buildLabelConfig(repoConfig, ['orch:ready'])
    expect(result.running).toBe('orch:running')
    expect(result.ready).toEqual(['orch:ready'])
  })

  it('uses kanban labels when trigger label is present', () => {
    const result = buildLabelConfig(repoConfig, ['flow:kanban', 'kanban:todo'])
    expect(result.running).toBe('kanban:doing')
    expect(result.ready).toEqual(['kanban:todo'])
  })

  it('adds kanban ready labels to discovery include labels', () => {
    const result = getDiscoveryIncludeLabels(repoConfig)
    expect(result).toEqual(['orch:ready', 'kanban:todo'])
  })

  it('detects kanban trigger label', () => {
    expect(isKanbanIssue(['flow:kanban'], repoConfig)).toBe(true)
    expect(isKanbanIssue(['orch:ready'], repoConfig)).toBe(false)
  })
})
