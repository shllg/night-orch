import type { ZodSchema } from 'zod'
import { AiInvalidResponseError } from './errors.js'

/**
 * Extract and validate the first top-level JSON object from a
 * model response. Tolerates:
 *  - Pure JSON (`{...}`)
 *  - JSON wrapped in fenced code blocks (` ```json ... ``` `)
 *  - JSON preceded or followed by prose ("Here's the JSON: { ... }
 *    Hope this helps!")
 *  - Models that emit the JSON inside an "answer" text block
 *
 * Rejects (throws `AiInvalidResponseError`) when:
 *  - No balanced `{...}` region exists in the response
 *  - The extracted region isn't valid JSON
 *  - The parsed object doesn't match the provided schema
 *
 * Used by `AiClient.completeStructured` for triage, reviewer parse
 * fallback, and any future structured-generation task.
 */
export function extractAndValidateJson<T>(
  raw: string,
  schema: ZodSchema<T>,
  provider: string,
  model: string,
): T {
  const candidate = extractFirstJsonObject(raw)
  if (candidate === null) {
    throw new AiInvalidResponseError(
      provider,
      model,
      'no JSON object found in response',
      raw,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (err) {
    throw new AiInvalidResponseError(
      provider,
      model,
      `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    )
  }

  const validation = schema.safeParse(parsed)
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new AiInvalidResponseError(
      provider,
      model,
      `schema validation failed: ${issues}`,
      raw,
    )
  }

  return validation.data
}

/**
 * Find the first balanced `{...}` region in `raw`. Uses a simple
 * brace-counter that tolerates nested objects and strings (strings
 * are parsed carefully to avoid counting `{` inside quoted text).
 *
 * Returns the raw substring (suitable for `JSON.parse`) or `null`
 * when no balanced region exists.
 */
function extractFirstJsonObject(raw: string): string | null {
  // Fast path: strip fenced code block markers so the brace scan
  // sees only content.
  const trimmed = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  const start = trimmed.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!

    if (escape) {
      escape = false
      continue
    }

    if (inString) {
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return trimmed.slice(start, i + 1)
      }
    }
  }

  return null
}
