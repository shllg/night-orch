import { describe, it, expect } from 'vitest'
import { buildLabelConfig, getDiscoveryIncludeLabels, isKanbanIssue } from '../../src/labels/config.js'

describe('label flow config', () => {
  const repoConfig = {
    labels: {
      ready: ['no:ready'],
      running: 'no:running',
      blocked: 'no:blocked',
      needsHuman: 'no:needs-human',
      reviewReady: 'no:review-ready',
      error: 'no:error',
      retry: 'no:retry',
      planning: 'no:planning',
      mergeQueued: 'no:merge-queued',
      merging: 'no:merging',
      mergeFailed: 'no:merge-failed',
      rebasing: 'no:rebasing',
    },
    selectors: {
      includeLabelsAny: ['no:ready'],
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
        rebasing: 'kanban:rebasing',
      },
    },
  }

  it('uses default labels when kanban trigger is absent', () => {
    const result = buildLabelConfig(repoConfig, ['no:ready'])
    expect(result.running).toBe('no:running')
    expect(result.ready).toEqual(['no:ready'])
    expect(result.rebasing).toBe('no:rebasing')
  })

  it('uses kanban labels when trigger label is present', () => {
    const result = buildLabelConfig(repoConfig, ['flow:kanban', 'kanban:todo'])
    expect(result.running).toBe('kanban:doing')
    expect(result.ready).toEqual(['kanban:todo'])
    expect(result.rebasing).toBe('kanban:rebasing')
  })

  it('adds kanban ready labels to discovery include labels', () => {
    const result = getDiscoveryIncludeLabels(repoConfig)
    expect(result).toEqual(['no:ready', 'kanban:todo'])
  })

  it('detects kanban trigger label', () => {
    expect(isKanbanIssue(['flow:kanban'], repoConfig)).toBe(true)
    expect(isKanbanIssue(['no:ready'], repoConfig)).toBe(false)
  })
})
