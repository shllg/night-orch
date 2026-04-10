import { describe, it, expect } from 'vitest'
import { parsePhaseData, SENTINEL_KEYS } from '../../src/loop/checkpoint-schema.js'

describe('parsePhaseData', () => {
  describe('empty and absent inputs', () => {
    it('treats null as empty', () => {
      const result = parsePhaseData(null)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data).toEqual({})
    })

    it('treats undefined as empty', () => {
      const result = parsePhaseData(undefined)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data).toEqual({})
    })

    it('treats empty string as empty', () => {
      const result = parsePhaseData('')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data).toEqual({})
    })
  })

  describe('valid shapes', () => {
    it('accepts an empty object', () => {
      const result = parsePhaseData('{}')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data).toEqual({})
    })

    it('accepts well-known sentinel keys', () => {
      const raw = JSON.stringify({
        [SENTINEL_KEYS.completedPhases]: ['plan', 'code'],
        [SENTINEL_KEYS.sessionIds]: { planner: 'sess-1', coder: 'sess-2' },
        [SENTINEL_KEYS.stepOutputs]: { 'lint-fix': { files: ['a.ts'] } },
        [SENTINEL_KEYS.decisionOutcomes]: {
          decision: { action: 'publish', reason: 'APPROVED + verify pass' },
        },
      })
      const result = parsePhaseData(raw)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data[SENTINEL_KEYS.completedPhases]).toEqual(['plan', 'code'])
      }
    })

    it('passes through ad-hoc free-form keys', () => {
      const raw = JSON.stringify({
        issueRepo: 'org/repo',
        reactionType: 'retry',
        reactionContext: 'human requested a retry',
        plan: { plan: { objective: 'x' } },
      })
      const result = parsePhaseData(raw)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data['issueRepo']).toBe('org/repo')
        expect(result.data['reactionType']).toBe('retry')
      }
    })

    it('accepts a decision outcome carrying the legacy blockReason string', () => {
      const raw = JSON.stringify({
        [SENTINEL_KEYS.decisionOutcomes]: {
          decision: { action: 'block', reason: 'cost', blockReason: 'cost_limit' },
        },
      })
      const result = parsePhaseData(raw)
      expect(result.ok).toBe(true)
    })
  })

  describe('parse errors', () => {
    it('rejects malformed JSON with reason=parse_error', () => {
      const result = parsePhaseData('{"foo":')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('parse_error')
        expect(result.detail.length).toBeGreaterThan(0)
        expect(result.payload).toBe('{"foo":')
      }
    })

    it('rejects garbage strings with reason=parse_error', () => {
      const result = parsePhaseData('not json at all')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('parse_error')
    })
  })

  describe('schema errors — top-level shape', () => {
    it('rejects JSON arrays with reason=schema_error', () => {
      const result = parsePhaseData('[]')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('schema_error')
        expect(result.detail).toContain('array')
      }
    })

    it('rejects JSON null with reason=schema_error', () => {
      const result = parsePhaseData('null')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('schema_error')
        expect(result.detail).toContain('null')
      }
    })

    it('rejects JSON strings with reason=schema_error', () => {
      const result = parsePhaseData('"just a string"')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('schema_error')
        expect(result.detail).toContain('string')
      }
    })

    it('rejects JSON numbers with reason=schema_error', () => {
      const result = parsePhaseData('42')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('schema_error')
    })
  })

  describe('schema errors — sentinel-key shape mismatches', () => {
    it('rejects __completedPhases containing a non-string', () => {
      const raw = JSON.stringify({ [SENTINEL_KEYS.completedPhases]: ['plan', 42] })
      const result = parsePhaseData(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('schema_error')
        expect(result.detail).toContain(SENTINEL_KEYS.completedPhases)
      }
    })

    it('rejects __sessionIds containing a non-string value', () => {
      const raw = JSON.stringify({ [SENTINEL_KEYS.sessionIds]: { planner: 123 } })
      const result = parsePhaseData(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('schema_error')
    })

    it('rejects __decisionOutcomes with an unknown action value', () => {
      const raw = JSON.stringify({
        [SENTINEL_KEYS.decisionOutcomes]: {
          decision: { action: 'bogus' },
        },
      })
      const result = parsePhaseData(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('schema_error')
    })
  })

  describe('payload truncation', () => {
    it('truncates the quarantine payload at 8 KiB', () => {
      const hugeString = '{"key":"' + 'x'.repeat(20_000) + '"'  // unterminated, triggers parse_error
      const result = parsePhaseData(hugeString)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.payload).not.toBeNull()
        expect(result.payload!.length).toBe(8 * 1024)
      }
    })
  })
})
