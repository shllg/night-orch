import { describe, it, expect } from 'vitest'
import { parseMentions } from '../../src/runner/comment-commands.js'
import type { ForgeComment } from '../../src/forge/types.js'

function comment(id: number, body: string, user = 'alice'): ForgeComment {
  return {
    id,
    body,
    user,
    createdAt: '2026-06-02T09:00:00Z',
    updatedAt: '2026-06-02T09:00:00Z',
  }
}

describe('parseMentions', () => {
  it('returns comments that mention a configured alias', () => {
    const result = parseMentions([
      comment(1, '@night-orch please add regression tests for foo'),
    ], ['@night-orch'])

    expect(result).toEqual([
      {
        commentId: 1,
        user: 'alice',
        body: '@night-orch please add regression tests for foo',
        alias: '@night-orch',
      },
    ])
  })

  it('ignores mentions inside fenced and indented code blocks', () => {
    const result = parseMentions([
      comment(1, '```\n@night-orch please retry\n```'),
      comment(2, '    @night-orch please retry'),
      comment(3, '@night-orch real feedback'),
    ], ['@night-orch'])

    expect(result.map((item) => item.commentId)).toEqual([3])
  })

  it('ignores marker-authored bot comments to avoid self-trigger loops', () => {
    const result = parseMentions([
      comment(1, '<!-- night-orch:status -->\n@night-orch queued continue', 'orch-bot'),
      comment(2, '@night-orch real feedback', 'alice'),
    ], ['@night-orch'])

    expect(result.map((item) => item.commentId)).toEqual([2])
  })

  it('records the longest matching alias when a comment contains overlapping aliases', () => {
    const result = parseMentions([
      comment(1, '@orch and @night-orch should use the stable bot alias'),
    ], ['@orch', '@night-orch'])

    expect(result[0]?.alias).toBe('@night-orch')
  })
})
