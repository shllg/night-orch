import { describe, it, expect } from 'vitest'
import { buildLabelBootstrapDefinitions } from '../../src/labels/bootstrap.js'

describe('buildLabelBootstrapDefinitions', () => {
  it('builds all configured labels with defaults', () => {
    const result = buildLabelBootstrapDefinitions({
      labels: {
        ready: ['orch:ready'],
        running: 'orch:running',
        blocked: ['orch:blocked', 'orch:needs-human'],
        reviewReady: 'orch:review-ready',
        error: 'orch:error',
        retry: 'orch:retry',
        planning: 'orch:planning',
        mergeQueued: 'orch:merge-queued',
        merging: 'orch:merging',
        mergeFailed: 'orch:merge-failed',
      },
      labelConfig: {},
    })

    expect(result.map((l) => l.name)).toEqual([
      'orch:ready',
      'orch:running',
      'orch:blocked',
      'orch:needs-human',
      'orch:review-ready',
      'orch:error',
      'orch:retry',
      'orch:planning',
      'orch:merge-queued',
      'orch:merging',
      'orch:merge-failed',
    ])
    expect(result.find((l) => l.name === 'orch:ready')).toEqual({
      name: 'orch:ready',
      color: '0E8A16',
      description: 'Queued for night-orch processing',
    })
  })

  it('applies per-label overrides from repo.labelConfig', () => {
    const result = buildLabelBootstrapDefinitions({
      labels: {
        ready: ['team:triage'],
        running: 'team:wip',
        blocked: ['team:blocked'],
        reviewReady: 'team:review',
        error: 'team:error',
        retry: 'team:retry',
        planning: 'team:planning',
        mergeQueued: 'team:merge-queued',
        merging: 'team:merging',
        mergeFailed: 'team:merge-failed',
      },
      labelConfig: {
        'team:triage': { color: 'abcdef', description: 'Ready in team workflow' },
        'team:error': { color: '123456' },
      },
    })

    expect(result.find((l) => l.name === 'team:triage')).toEqual({
      name: 'team:triage',
      color: 'ABCDEF',
      description: 'Ready in team workflow',
    })
    expect(result.find((l) => l.name === 'team:error')).toEqual({
      name: 'team:error',
      color: '123456',
      description: 'Processing failed and needs investigation',
    })
  })

  it('deduplicates repeated labels across roles', () => {
    const result = buildLabelBootstrapDefinitions({
      labels: {
        ready: ['orch:shared'],
        running: 'orch:shared',
        blocked: ['orch:shared'],
        reviewReady: 'orch:shared',
        error: 'orch:shared',
        retry: 'orch:shared',
        planning: 'orch:shared',
        mergeQueued: 'orch:shared',
        merging: 'orch:shared',
        mergeFailed: 'orch:shared',
      },
      labelConfig: {},
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('orch:shared')
  })

  it('includes kanban trigger and kanban state labels when configured', () => {
    const result = buildLabelBootstrapDefinitions({
      labels: {
        ready: ['orch:ready'],
        running: 'orch:running',
        blocked: ['orch:blocked'],
        needsHuman: 'orch:needs-human',
        reviewReady: 'orch:review-ready',
        error: 'orch:error',
        retry: 'orch:retry',
        planning: 'orch:planning',
        mergeQueued: 'orch:merge-queued',
        merging: 'orch:merging',
        mergeFailed: 'orch:merge-failed',
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
      labelConfig: {},
    })

    expect(result.map((l) => l.name)).toEqual(expect.arrayContaining([
      'flow:kanban',
      'kanban:todo',
      'kanban:doing',
      'kanban:blocked',
      'kanban:needs-human',
      'kanban:review',
      'kanban:error',
      'kanban:retry',
      'kanban:planning',
      'kanban:merge-queued',
      'kanban:merging',
      'kanban:merge-failed',
    ]))
  })
})
