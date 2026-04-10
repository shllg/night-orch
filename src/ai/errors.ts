/**
 * Typed errors for the Phase 3 AI layer.
 *
 * The hierarchy mirrors the shape of R2's `WorkerError` family so
 * consumers can classify failures the same way across CLI workers
 * and direct-API calls:
 *
 *  - `AiAuthError`      → operator must fix credentials
 *  - `AiRateLimitError` → transient, caller may retry with backoff
 *  - `AiInvalidResponseError` → provider returned something we
 *    couldn't parse (schema violation, truncated JSON, etc.)
 *  - `AiTransientError` → network blip, 5xx, timeout — safe to retry
 *  - `AiError` (base)   → everything else
 *
 * Each subclass carries `provider` + `model` context so error
 * logs and cost-report drilldowns can point at the specific
 * endpoint that misbehaved.
 */

export abstract class AiError extends Error {
  abstract readonly code: string

  constructor(
    public readonly provider: string,
    public readonly model: string,
    message: string,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

export class AiAuthError extends AiError {
  readonly code = 'AI_AUTH_FAILURE' as const
  constructor(provider: string, model: string, detail: string) {
    super(provider, model, `${provider} authentication failure: ${detail}`)
  }
}

export class AiRateLimitError extends AiError {
  readonly code = 'AI_RATE_LIMIT' as const
  constructor(
    provider: string,
    model: string,
    detail: string,
    public readonly retryAfterMs?: number,
  ) {
    super(provider, model, `${provider} rate-limited: ${detail}`)
  }
}

export class AiInvalidResponseError extends AiError {
  readonly code = 'AI_INVALID_RESPONSE' as const
  constructor(
    provider: string,
    model: string,
    detail: string,
    public readonly rawResponse?: string,
  ) {
    super(provider, model, `${provider} returned invalid response: ${detail}`)
  }
}

export class AiTransientError extends AiError {
  readonly code = 'AI_TRANSIENT_FAILURE' as const
  constructor(
    provider: string,
    model: string,
    detail: string,
    public readonly httpStatus?: number,
  ) {
    super(provider, model, `${provider} transient failure: ${detail}`)
  }
}

export function isAiError(err: unknown): err is AiError {
  return err instanceof AiError
}

export function isTransientAiError(err: unknown): err is AiTransientError | AiRateLimitError {
  return err instanceof AiTransientError || err instanceof AiRateLimitError
}
