import { describe, it, expect } from 'vitest'
import { resolveMentions } from '../../src/mentions/resolver.js'

const defaults = {
  planner: 'claude' as const,
  coder: 'claude' as const,
  reviewer: 'claude' as const,
  doneMode: 'pr-ready' as const,
  notifyPriority: 'normal' as const,
  prMentions: ['codex'],
}

describe('resolveMentions', () => {
  it('issue label pr-mention:claude → include claude', () => {
    const result = resolveMentions(
      ['pr-mention:claude', 'bug'],
      { ...defaults, prMentions: [] },
      {},
    )
    expect(result).toContain('claude')
  })

  it('no labels → use repo defaults', () => {
    const result = resolveMentions([], defaults, {})
    expect(result).toEqual(['codex'])
  })

  it('appMentions.codex.enabled: false → exclude codex even if in defaults', () => {
    const result = resolveMentions([], defaults, {
      codex: { enabled: false, commentTemplate: '@codex' },
    })
    expect(result).not.toContain('codex')
  })

  it('both label and default → no duplicates', () => {
    const result = resolveMentions(
      ['pr-mention:codex'],
      defaults,
      {},
    )
    // codex from both label and default, but only once
    const codexCount = result.filter((m) => m === 'codex').length
    expect(codexCount).toBe(1)
  })

  it('multiple labels → all resolved', () => {
    const result = resolveMentions(
      ['pr-mention:claude', 'pr-mention:gemini'],
      { ...defaults, prMentions: [] },
      {},
    )
    expect(result).toContain('claude')
    expect(result).toContain('gemini')
  })

  it('non pr-mention labels are ignored', () => {
    const result = resolveMentions(
      ['bug', 'enhancement', 'no:ready'],
      { ...defaults, prMentions: [] },
      {},
    )
    expect(result).toEqual([])
  })

  it('enabled appMention is not filtered out', () => {
    const result = resolveMentions([], defaults, {
      codex: { enabled: true, commentTemplate: '@codex please review' },
    })
    expect(result).toContain('codex')
  })
})
