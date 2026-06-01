import { z } from 'zod'

const updateStrategySchema = z.enum(['merge', 'rebase'])

const commonControlPayloadSchema = z
  .object({
    issueRepo: z.string().optional(),
    preserveBranchState: z.boolean().optional(),
    updateStrategy: updateStrategySchema.optional(),
    checkAfter: z.boolean().optional(),
    requestedAt: z.string().optional(),
    conflictSummary: z.string().optional(),
    conflictFiles: z.array(z.string()).optional(),
    conflictExcerpts: z.array(z.unknown()).optional(),
    conflictSnapshot: z.unknown().optional(),
    resolutionAttempted: z.boolean().optional(),
    resolutionOutcome: z.string().nullable().optional(),
    resolvedFiles: z.array(z.string()).optional(),
    resetPlan: z.boolean().optional(),
    resetBranch: z.boolean().optional(),
    retryRequestedAt: z.string().optional(),
  })
  .passthrough()

const sourcedControlPayloadSchema = z.discriminatedUnion('source', [
  commonControlPayloadSchema.extend({ source: z.literal('manual_continue') }),
  commonControlPayloadSchema.extend({ source: z.literal('rebase_conflict') }),
  commonControlPayloadSchema.extend({ source: z.literal('cost_reset') }),
  commonControlPayloadSchema.extend({ source: z.literal('cost_auto_resume') }),
])

const legacyControlPayloadSchema = commonControlPayloadSchema.extend({
  source: z.undefined().optional(),
})

export const RunControlPayloadSchema = z.union([
  sourcedControlPayloadSchema,
  legacyControlPayloadSchema,
])

export type RunControlPayload = z.infer<typeof RunControlPayloadSchema>

export interface ParsePayloadSuccess {
  ok: true
  data: Record<string, unknown>
}

export interface ParsePayloadFailure {
  ok: false
  reason: 'parse_error' | 'schema_error'
  detail: string
  payload: string | null
}

export type ParsePayloadResult = ParsePayloadSuccess | ParsePayloadFailure

const MAX_PAYLOAD_BYTES = 8 * 1024

export function parseControlPayload(raw: string | null | undefined): ParsePayloadResult {
  if (raw === null || raw === undefined || raw.length === 0) {
    return { ok: true, data: {} }
  }

  const truncated = truncatePayload(raw)
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

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: 'schema_error',
      detail: `control_payload top-level value is ${describeTopLevel(parsed)}; expected a plain object`,
      payload: truncated,
    }
  }

  const validation = parseControlPayloadValue(parsed)
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

export function validateControlPayloadForWrite(value: Record<string, unknown>): Record<string, unknown> {
  const validation = parseControlPayloadValue(value)
  if (!validation.success) {
    throw new Error(`control_payload failed validation: ${formatZodIssues(validation.error)}`)
  }
  return validation.data as Record<string, unknown>
}

function parseControlPayloadValue(value: Record<string, unknown>): z.SafeParseReturnType<unknown, RunControlPayload> {
  return value.source === undefined
    ? legacyControlPayloadSchema.safeParse(value)
    : sourcedControlPayloadSchema.safeParse(value)
}

function truncatePayload(raw: string): string {
  return raw.length > MAX_PAYLOAD_BYTES ? raw.slice(0, MAX_PAYLOAD_BYTES) : raw
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeTopLevel(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}
