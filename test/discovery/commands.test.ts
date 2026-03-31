import { describe, it, expect, beforeEach } from 'vitest'
import { parseOrchCommands, isCommandProcessed, markCommandProcessed } from '../../src/discovery/commands.js'
import type { ForgeComment } from '../../src/forge/types.js'
import { initDatabase } from '../../src/state/db.js'

function makeComment(id: number, body: string, createdAt = '2026-01-02T00:00:00Z', user = 'human'): ForgeComment {
  return { id, body, user, createdAt, updatedAt: createdAt }
}

describe('parseOrchCommands', () => {
  const since = '2026-01-01T00:00:00Z'

  it('parses /orch retry', () => {
    const comments = [makeComment(1, '/orch retry')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(1)
    expect(result[0]!.command).toEqual({ type: 'retry', resetPlan: false })
  })

  it('parses /night-orch retry --reset-plan', () => {
    const comments = [makeComment(1, '/night-orch retry --reset-plan')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(1)
    expect(result[0]!.command).toEqual({ type: 'retry', resetPlan: true })
  })

  it('parses /orch rebase', () => {
    const comments = [makeComment(1, '/orch rebase')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(1)
    expect(result[0]!.command).toEqual({ type: 'rebase', checkAfter: true })
  })

  it('parses /orch continue', () => {
    const comments = [makeComment(1, '/orch continue')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(1)
    expect(result[0]!.command).toEqual({ type: 'continue' })
  })

  it('parses /orch cancel', () => {
    const comments = [makeComment(1, '/orch cancel')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(1)
    expect(result[0]!.command).toEqual({ type: 'cancel' })
  })

  it('ignores unknown commands', () => {
    const comments = [makeComment(1, '/orch foobar')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(0)
  })

  it('ignores commands before sinceTimestamp', () => {
    const comments = [makeComment(1, '/orch retry', '2025-12-31T00:00:00Z')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(0)
  })

  it('ignores commands inside code blocks', () => {
    const comments = [makeComment(1, '```\n/orch retry\n```')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(0)
  })

  it('parses command with surrounding text', () => {
    const comments = [makeComment(1, 'Please do this:\n/orch continue\nThanks')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(1)
    expect(result[0]!.command).toEqual({ type: 'continue' })
  })

  it('ignores comments with no command', () => {
    const comments = [makeComment(1, 'Just a regular comment')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(0)
  })

  it('returns correct user and commentId', () => {
    const comments = [makeComment(42, '/orch retry', '2026-01-02T00:00:00Z', 'reviewer')]
    const result = parseOrchCommands(comments, since)
    expect(result).toHaveLength(1)
    expect(result[0]!.commentId).toBe(42)
    expect(result[0]!.user).toBe('reviewer')
  })
})

describe('command tracking', () => {
  let db: ReturnType<typeof initDatabase>

  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  it('marks and detects processed commands', () => {
    expect(isCommandProcessed(db, 'org/repo', 1, 42)).toBe(false)
    markCommandProcessed(db, 'org/repo', 1, 42, 'retry')
    expect(isCommandProcessed(db, 'org/repo', 1, 42)).toBe(true)
  })

  it('does not conflict across different issues', () => {
    markCommandProcessed(db, 'org/repo', 1, 42, 'retry')
    expect(isCommandProcessed(db, 'org/repo', 2, 42)).toBe(false)
  })

  it('INSERT OR IGNORE on duplicate', () => {
    markCommandProcessed(db, 'org/repo', 1, 42, 'retry')
    // Should not throw
    markCommandProcessed(db, 'org/repo', 1, 42, 'retry')
    expect(isCommandProcessed(db, 'org/repo', 1, 42)).toBe(true)
  })
})
