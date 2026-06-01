import { describe, expect, it } from 'vitest'
import {
  parseControlPayload,
  validateControlPayloadForWrite,
} from '../../src/state/run-payloads.js'

describe('run payload schemas', () => {
  describe('control payloads', () => {
    it('accepts legacy payloads that have no source discriminator', () => {
      const result = parseControlPayload(JSON.stringify({
        issueRepo: 'org/repo',
        preserveBranchState: true,
        updateStrategy: 'rebase',
      }))

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toMatchObject({
          issueRepo: 'org/repo',
          preserveBranchState: true,
          updateStrategy: 'rebase',
        })
      }
    })

    it('accepts sourced continue payloads', () => {
      const payload = validateControlPayloadForWrite({
        source: 'manual_continue',
        issueRepo: 'org/repo',
        preserveBranchState: true,
        requestedAt: '2026-01-01T00:00:00.000Z',
      })

      expect(payload.source).toBe('manual_continue')
    })

    it('rejects unknown update strategies', () => {
      const result = parseControlPayload(JSON.stringify({
        issueRepo: 'org/repo',
        updateStrategy: 'squash',
      }))

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('schema_error')
        expect(result.detail).toContain('updateStrategy')
      }
    })

    it('rejects unknown source discriminators', () => {
      expect(() => validateControlPayloadForWrite({
        source: 'typo_continue',
        issueRepo: 'org/repo',
      })).toThrow(/control_payload failed validation/)
    })
  })
})
