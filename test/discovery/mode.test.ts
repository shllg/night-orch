import { describe, it, expect } from 'vitest'
import { resolveExecutionMode } from '../../src/discovery/mode.js'

describe('resolveExecutionMode', () => {
  it('returns planning when issue has configured planning label', () => {
    const mode = resolveExecutionMode(
      ['bug', 'orch:planning'],
      { planning: { label: 'orch:planning', outputDir: 'docs/prd' } },
    )
    expect(mode).toBe('planning')
  })

  it('returns implementation when planning label is missing', () => {
    const mode = resolveExecutionMode(
      ['bug', 'orch:ready'],
      { planning: { label: 'orch:planning', outputDir: 'docs/prd' } },
    )
    expect(mode).toBe('implementation')
  })

  it('falls back to default planning label when config is missing', () => {
    const mode = resolveExecutionMode(['orch:planning'], {})
    expect(mode).toBe('planning')
  })
})
