import { z } from 'zod'

/**
 * R5: zod schema for the `runs.phase_data` JSON blob.
 *
 * Before R5 the phase_data was an unvalidated `Record<string, unknown>`
 * parsed through a defensive `safeParsePhaseData` that silently
 * returned `{}` on any failure. A corrupt row would rehydrate as
 * "no checkpoint" with zero operator visibility — the exact failure
 * mode the plan file calls out at `checkpoint.ts:549-566` in the
 * exploration notes.
 *
 * This module defines a structured schema for the parts of
 * phase_data we actively use (the sentinel keys and well-known
 * phase artifacts) and a `parsePhaseData()` helper that returns
 * either a validated result or a `QuarantineError` describing
 * exactly what went wrong. The caller (`checkpoint.ts`) writes the
 * failing payload to the `checkpoint_quarantine` table (migration
 * 026) and continues with an empty shape — the same behavior as
 * pre-R5 but with an audit trail.
 *
 * The schema uses `.passthrough()` on the top-level object because
 * the engine's phase handlers and the retry/continue/rebase flows
 * add ad-hoc keys (issueRepo, reactionType, reactionContext, …) to
 * phase_data that we don't want to strictly validate here. Only the
 * sentinel keys have enforced shapes; everything else is free-form
 * unknown.
 */

export const SENTINEL_KEYS = {
  completedPhases: '__completedPhases',
  sessionIds: '__sessionIds',
  stepOutputs: '__stepOutputs',
  decisionOutcomes: '__decisionOutcomes',
} as const

/**
 * Persisted shape of a decide-step outcome. Mirrors
 * `PersistedDecisionOutcome` in `checkpoint.ts` — kept as a loose
 * record because the R1 rewiring still stores the legacy `blockReason`
 * string here for crash-recovery back-compat (R5 migrates the live
 * path but does not rewrite this persisted field).
 */
const persistedDecisionOutcomeSchema = z.object({
  action: z.enum(['publish', 'iterate', 'block', 'error']),
  reason: z.string().optional(),
  blockReason: z.string().nullable().optional(),
})

export type PersistedDecisionOutcome = z.infer<typeof persistedDecisionOutcomeSchema>

/**
 * Top-level phase_data schema. Sentinel keys are validated; any
 * other key (phase artifact objects, per-attempt scratch fields)
 * passes through as `unknown`.
 */
export const PhaseDataSchema = z
  .object({
    [SENTINEL_KEYS.completedPhases]: z.array(z.string()).optional(),
    [SENTINEL_KEYS.sessionIds]: z.record(z.string()).optional(),
    [SENTINEL_KEYS.stepOutputs]: z.record(z.unknown()).optional(),
    [SENTINEL_KEYS.decisionOutcomes]: z
      .record(persistedDecisionOutcomeSchema)
      .optional(),
  })
  .passthrough()

export type ValidatedPhaseData = z.infer<typeof PhaseDataSchema>

export interface ParsePhaseDataSuccess {
  ok: true
  data: Record<string, unknown>
}

export interface ParsePhaseDataFailure {
  ok: false
  reason: 'parse_error' | 'schema_error'
  detail: string
  /** Original raw string (possibly truncated) so the caller can quarantine it. */
  payload: string | null
}

export type ParsePhaseDataResult = ParsePhaseDataSuccess | ParsePhaseDataFailure

const MAX_QUARANTINE_PAYLOAD_BYTES = 8 * 1024

/**
 * Parse and validate a raw `phase_data` JSON string.
 *
 * - `null` / empty input → `{ ok: true, data: {} }` (treated as "no checkpoint")
 * - `JSON.parse` failure → `{ ok: false, reason: 'parse_error', ... }`
 * - Non-object top-level value → `{ ok: false, reason: 'schema_error', ... }`
 * - Sentinel-key shape mismatch → `{ ok: false, reason: 'schema_error', ... }`
 * - Valid → `{ ok: true, data: parsed }`
 *
 * The `payload` on failure is the raw string truncated to 8 KiB so
 * the quarantine table row stays compact even when a pathological
 * phase_data is absurdly large.
 */
export function parsePhaseData(raw: string | null | undefined): ParsePhaseDataResult {
  if (raw === null || raw === undefined || raw.length === 0) {
    return { ok: true, data: {} }
  }

  const truncated = raw.length > MAX_QUARANTINE_PAYLOAD_BYTES
    ? raw.slice(0, MAX_QUARANTINE_PAYLOAD_BYTES)
    : raw

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      ok: false,
      reason: 'parse_error',
      detail: err instanceof Error ? err.message : String(err),
      payload: truncated,
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'schema_error',
      detail: `phase_data top-level value is ${
        parsed === null
          ? 'null'
          : Array.isArray(parsed)
            ? 'array'
            : typeof parsed
      }; expected a plain object`,
      payload: truncated,
    }
  }

  const validation = PhaseDataSchema.safeParse(parsed)
  if (!validation.success) {
    return {
      ok: false,
      reason: 'schema_error',
      detail: formatZodIssues(validation.error),
      payload: truncated,
    }
  }

  return { ok: true, data: validation.data as Record<string, unknown> }
}

export function validatePhaseDataForWrite(value: Record<string, unknown>): Record<string, unknown> {
  const validation = PhaseDataSchema.safeParse(value)
  if (!validation.success) {
    throw new Error(`phase_data failed validation: ${formatZodIssues(validation.error)}`)
  }
  return validation.data as Record<string, unknown>
}

export function extractDecisionOutcomes(
  phaseData: Record<string, unknown> | null | undefined,
): Record<string, PersistedDecisionOutcome> {
  if (!phaseData) return {}
  const validation = PhaseDataSchema.safeParse(phaseData)
  if (!validation.success) return {}
  return validation.data[SENTINEL_KEYS.decisionOutcomes] ?? {}
}

export function extractCompletedPhases(
  phaseData: Record<string, unknown> | null | undefined,
): string[] {
  if (!phaseData) return []
  const validation = PhaseDataSchema.safeParse(phaseData)
  if (!validation.success) return []
  return validation.data[SENTINEL_KEYS.completedPhases] ?? []
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}
