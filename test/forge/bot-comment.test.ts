import { describe, it, expect, vi } from 'vitest'
import { markerTag, findBotComment, upsertBotComment } from '../../src/forge/bot-comment.js'
import type { ForgeAdapter, ForgeComment } from '../../src/forge/types.js'

describe('bot-comment', () => {
  describe('markerTag', () => {
    it('builds HTML comment marker', () => {
      expect(markerTag('plan')).toBe('<!-- night-orch:plan -->')
      expect(markerTag('status')).toBe('<!-- night-orch:status -->')
    })
  })

  describe('findBotComment', () => {
    const marker = markerTag('status')

    it('finds comment with matching marker and author', () => {
      const comments: ForgeComment[] = [
        { id: 1, body: 'unrelated', user: 'human', createdAt: '', updatedAt: '' },
        { id: 2, body: `${marker}\nBlocked`, user: 'bot', createdAt: '', updatedAt: '' },
      ]
      const found = findBotComment(comments, marker, 'bot')
      expect(found?.id).toBe(2)
    })

    it('ignores spoofed marker from different author', () => {
      const comments: ForgeComment[] = [
        { id: 1, body: `${marker}\nSpoofed`, user: 'attacker', createdAt: '', updatedAt: '' },
      ]
      const found = findBotComment(comments, marker, 'bot')
      expect(found).toBeUndefined()
    })

    it('returns undefined when no match', () => {
      const comments: ForgeComment[] = [
        { id: 1, body: 'No marker here', user: 'bot', createdAt: '', updatedAt: '' },
      ]
      const found = findBotComment(comments, marker, 'bot')
      expect(found).toBeUndefined()
    })
  })

  describe('upsertBotComment', () => {
    const marker = markerTag('status')

    function makeMockForge(existingComments: ForgeComment[]) {
      return {
        listIssueComments: vi.fn().mockResolvedValue(existingComments),
        updateComment: vi.fn().mockResolvedValue(undefined),
        commentOnIssue: vi.fn().mockResolvedValue(undefined),
      } as unknown as ForgeAdapter
    }

    it('creates new comment when none exists', async () => {
      const forge = makeMockForge([])
      const result = await upsertBotComment(forge, 'org/repo', 1, marker, 'New status', 'bot')

      expect(result.created).toBe(true)
      expect(forge.commentOnIssue).toHaveBeenCalledWith('org/repo', 1, `${marker}\nNew status`)
      expect(forge.updateComment).not.toHaveBeenCalled()
    })

    it('updates existing comment when bot comment found', async () => {
      const existing: ForgeComment[] = [
        { id: 42, body: `${marker}\nOld status`, user: 'bot', createdAt: '', updatedAt: '' },
      ]
      const forge = makeMockForge(existing)
      const result = await upsertBotComment(forge, 'org/repo', 1, marker, 'Updated status', 'bot')

      expect(result.created).toBe(false)
      expect(forge.updateComment).toHaveBeenCalledWith('org/repo', 42, `${marker}\nUpdated status`)
      expect(forge.commentOnIssue).not.toHaveBeenCalled()
    })

    it('creates new comment when existing is from different author', async () => {
      const existing: ForgeComment[] = [
        { id: 42, body: `${marker}\nSpoofed`, user: 'attacker', createdAt: '', updatedAt: '' },
      ]
      const forge = makeMockForge(existing)
      const result = await upsertBotComment(forge, 'org/repo', 1, marker, 'Real status', 'bot')

      expect(result.created).toBe(true)
      expect(forge.commentOnIssue).toHaveBeenCalled()
    })
  })
})
