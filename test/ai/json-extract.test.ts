import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { extractAndValidateJson } from '../../src/ai/json-extract.js'
import { AiInvalidResponseError } from '../../src/ai/errors.js'

const schema = z.object({
  verdict: z.enum(['APPROVED', 'CHANGES_REQUIRED', 'BLOCKED']),
  count: z.number(),
})

describe('extractAndValidateJson', () => {
  it('extracts plain JSON from a bare object', () => {
    const raw = '{"verdict":"APPROVED","count":3}'
    expect(extractAndValidateJson(raw, schema, 'anthropic', 'test')).toEqual({
      verdict: 'APPROVED',
      count: 3,
    })
  })

  it('extracts JSON from a fenced code block', () => {
    const raw = '```json\n{"verdict":"BLOCKED","count":1}\n```'
    expect(extractAndValidateJson(raw, schema, 'anthropic', 'test')).toEqual({
      verdict: 'BLOCKED',
      count: 1,
    })
  })

  it('extracts JSON preceded by prose', () => {
    const raw = 'Here is the response: {"verdict":"CHANGES_REQUIRED","count":2} — hope that helps!'
    expect(extractAndValidateJson(raw, schema, 'anthropic', 'test')).toEqual({
      verdict: 'CHANGES_REQUIRED',
      count: 2,
    })
  })

  it('extracts the first JSON object when multiple exist', () => {
    const raw = '{"verdict":"APPROVED","count":1} {"verdict":"BLOCKED","count":2}'
    expect(extractAndValidateJson(raw, schema, 'anthropic', 'test')).toEqual({
      verdict: 'APPROVED',
      count: 1,
    })
  })

  it('tolerates nested braces inside the object', () => {
    const nestedSchema = z.object({
      verdict: z.enum(['APPROVED']),
      meta: z.object({ nested: z.boolean() }),
    })
    const raw = '{"verdict":"APPROVED","meta":{"nested":true}}'
    expect(extractAndValidateJson(raw, nestedSchema, 'anthropic', 'test')).toEqual({
      verdict: 'APPROVED',
      meta: { nested: true },
    })
  })

  it('tolerates braces inside strings', () => {
    const stringSchema = z.object({
      verdict: z.enum(['APPROVED']),
      note: z.string(),
    })
    const raw = '{"verdict":"APPROVED","note":"this has { braces } in it"}'
    expect(extractAndValidateJson(raw, stringSchema, 'anthropic', 'test')).toEqual({
      verdict: 'APPROVED',
      note: 'this has { braces } in it',
    })
  })

  it('throws AiInvalidResponseError when no JSON object is present', () => {
    expect(() => extractAndValidateJson('no braces here', schema, 'anthropic', 'test')).toThrow(
      AiInvalidResponseError,
    )
  })

  it('throws AiInvalidResponseError on malformed JSON', () => {
    expect(() =>
      extractAndValidateJson('{"verdict": "APPROVED", count:', schema, 'anthropic', 'test'),
    ).toThrow(AiInvalidResponseError)
  })

  it('throws AiInvalidResponseError when schema validation fails', () => {
    expect(() =>
      extractAndValidateJson('{"verdict":"MAYBE","count":1}', schema, 'anthropic', 'test'),
    ).toThrow(AiInvalidResponseError)
  })

  it('carries provider and model context on the error', () => {
    try {
      extractAndValidateJson('no json', schema, 'openrouter', 'claude-3-5-sonnet')
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AiInvalidResponseError)
      if (err instanceof AiInvalidResponseError) {
        expect(err.provider).toBe('openrouter')
        expect(err.model).toBe('claude-3-5-sonnet')
      }
    }
  })
})
