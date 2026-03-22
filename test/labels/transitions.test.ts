import { describe, it, expect } from 'vitest'
import { computeLabelMutation, type LabelConfig } from '../../src/labels/transitions.js'

const config: LabelConfig = {
  ready: ['orch:ready'],
  running: 'orch:running',
  blocked: ['orch:blocked', 'orch:needs-human'],
  reviewReady: 'orch:review-ready',
  error: 'orch:error',
  retry: 'orch:retry',
}

describe('computeLabelMutation', () => {
  it('queued → running: add running, remove ready', () => {
    const m = computeLabelMutation('queued', 'running', ['orch:ready'], config)
    expect(m.add).toEqual(['orch:running'])
    expect(m.remove).toEqual(['orch:ready'])
  })

  it('running → blocked: add blocked labels, remove running', () => {
    const m = computeLabelMutation('running', 'blocked', ['orch:running'], config)
    expect(m.add).toEqual(['orch:blocked', 'orch:needs-human'])
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

  it('blocked → running (retry): add running, remove blocked + error + retry', () => {
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
      ['orch:error', 'orch:running', 'orch:retry', 'orch:blocked'],
      config,
    )
    expect(m.add).toEqual(['orch:ready'])
    expect(m.remove).toContain('orch:error')
    expect(m.remove).toContain('orch:running')
    expect(m.remove).toContain('orch:blocked')
    expect(m.remove).toContain('orch:retry')
  })
})
