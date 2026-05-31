import { describe, it, expect } from 'vitest'
import { resolveRoles } from '../../src/discovery/roles.js'

const defaults = {
  planner: 'claude' as const,
  coder: 'claude' as const,
  reviewer: 'claude' as const,
  doneMode: 'pr-ready' as const,
  notifyPriority: 'normal' as const,
  prMentions: [] as string[],
}

describe('resolveRoles', () => {
  it('uses repo defaults when no labels present', () => {
    const result = resolveRoles([], defaults)
    expect(result).toEqual({ planner: 'claude', coder: 'claude', reviewer: 'claude' })
  })

  it('labels override repo defaults', () => {
    const result = resolveRoles(['code:codex', 'review:codex'], defaults)
    expect(result).toEqual({ planner: 'claude', coder: 'codex', reviewer: 'codex' })
  })

  it('partial labels fill others from defaults', () => {
    const result = resolveRoles(['plan:codex'], defaults)
    expect(result).toEqual({ planner: 'codex', coder: 'claude', reviewer: 'claude' })
  })

  it('throws on conflicting labels', () => {
    expect(() => resolveRoles(['plan:claude', 'plan:codex'], defaults)).toThrow(
      /Conflicting labels for planner/,
    )
  })

  it('throws on unknown agent name', () => {
    expect(() => resolveRoles(['code:gpt4'], defaults)).toThrow(/Unknown agent "gpt4"/)
  })

  it('ignores non-role labels', () => {
    const result = resolveRoles(['no:ready', 'bug', 'code:codex'], defaults)
    expect(result.coder).toBe('codex')
    expect(result.planner).toBe('claude')
  })

  it('accepts opencode as a valid agent name', () => {
    const result = resolveRoles(['code:opencode', 'review:opencode'], defaults)
    expect(result).toEqual({ planner: 'claude', coder: 'opencode', reviewer: 'opencode' })
  })

  it('accepts opencode in defaults', () => {
    const opencodeDefaults = { ...defaults, coder: 'opencode' as const }
    const result = resolveRoles([], opencodeDefaults)
    expect(result.coder).toBe('opencode')
  })
})
