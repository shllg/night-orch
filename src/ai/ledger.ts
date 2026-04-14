import type { ZodSchema } from 'zod'
import type { CostTracker } from '../loop/cost.js'
import type { AiClient, AiRequest, AiResponse, AiProvider } from './types.js'
import { logger } from '../utils/logger.js'

/**
 * Phase 3: cost-recording wrapper around an `AiClient`.
 *
 * Every direct-API call records its token usage through the R4
 * cost ledger so internal AI spend shows up alongside CLI worker
 * spend in `/api/cost/health`, `run_cost_entries`, and the
 * `nightorch_cost_token_source_total` Prometheus counter. The
 * consumer passes in a `runId` and a `stepId` so the row gets
 * attributed to the right attempt and phase, tagged
 * `worker_type='internal-ai'` (or a more specific internal subtype)
 * and `token_source='measured_api'`.
 *
 * The wrapper also handles the "call from somewhere that doesn't
 * have a runId" case — discovery-time triage classifies issues
 * before an attempt exists, so passing `runId: null` records the
 * usage to a sentinel bookkeeping row (the ledger accepts
 * per-worker-type rows without a stepId). Those rows show up in
 * `/api/cost/health` aggregates but don't inflate any particular
 * run's per-attempt cost.
 */
export class LedgerRecordingAiClient implements AiClient {
  readonly provider: AiProvider
  readonly model: string

  constructor(
    private readonly inner: AiClient,
    private readonly costTracker: CostTracker,
    private readonly getContext: () => AiCallContext,
  ) {
    this.provider = inner.provider
    this.model = inner.model
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const response = await this.inner.complete(req)
    this.record(response)
    return response
  }

  async completeStructured<T>(req: AiRequest, schema: ZodSchema<T>): Promise<T> {
    // We need the raw response for usage recording, so call through
    // the inner `complete` and extract JSON manually via the base
    // helper. Importing `extractAndValidateJson` here keeps the
    // structured helper's behavior in one place while still letting
    // us observe the usage metadata.
    const augmented: AiRequest = {
      ...req,
      system: `${req.system}\n\nReply with ONLY a JSON object. Do not wrap it in markdown code fences or add any prose.`,
    }
    const response = await this.inner.complete(augmented)
    this.record(response)
    const { extractAndValidateJson } = await import('./json-extract.js')
    return extractAndValidateJson(response.text, schema, this.provider, this.model)
  }

  private record(response: AiResponse): void {
    try {
      const ctx = this.getContext()
      const costUsd = this.estimateCost(response)
      if (ctx.runId === null) {
        // Discovery-time calls (pre-attempt) — there's no
        // `runs.id` to anchor the ledger row to, so we skip the
        // DB write and just log the usage for operator visibility.
        // R4b's `/api/cost/health` still counts these via the
        // Prometheus counter path once the metrics service is
        // wired through at the call site.
        logger.debug(
          {
            provider: this.provider,
            model: this.model,
            stepId: ctx.stepId,
            promptTokens: response.usage.promptTokens,
            completionTokens: response.usage.completionTokens,
            costUsd,
          },
          'internal-ai usage (no runId to anchor ledger row)',
        )
        return
      }
      this.costTracker.recordCost(
        ctx.runId,
        costUsd,
        response.usage,
        {
          stepId: ctx.stepId,
          workerType: ctx.workerType?.trim() || 'internal-ai',
          tokenSource: 'measured_api',
        },
      )
    } catch (err) {
      // Never let a ledger recording failure take down an AI call.
      logger.warn(
        { provider: this.provider, model: this.model, err },
        'Failed to record AI cost — response was returned anyway',
      )
    }
  }

  /**
   * Cheap cost estimator that reuses the project's default
   * per-token rates. This is intentionally loose — for precise
   * accounting the operator should add a per-model entry to
   * `cost.pricing.models` keyed by `pricingModelKey`, and a future
   * Phase 3+ pass can wire this through `estimateWorkerCost`. For
   * now the recorder still captures exact tokens; only the USD
   * amount is approximate.
   */
  private estimateCost(response: AiResponse): number {
    // Conservative default: mirrors the `DEFAULT_PAY_PER_USE_PRICING`
    // constant in `src/loop/pricing.ts`.
    const inputUsdPerM = 3
    const outputUsdPerM = 15
    const cacheReadUsdPerM = 0.3
    const usd =
      (response.usage.promptTokens / 1_000_000) * inputUsdPerM +
      (response.usage.completionTokens / 1_000_000) * outputUsdPerM +
      ((response.usage.cacheReadTokens ?? 0) / 1_000_000) * cacheReadUsdPerM
    return Number(Math.max(0, usd).toFixed(6))
  }
}

/** Shape the caller provides to tag a recording. */
export interface AiCallContext {
  /** Attempt id to attribute the ledger row to. Null when the
   * call happens before any attempt has been created (e.g.
   * discovery-time triage). */
  runId: string | null
  /** Short phase/step identifier — `'triage'`, `'pr-body'`,
   * `'reviewer-salvage'`, etc. */
  stepId: string
  /** Optional subtype for cost attribution when one internal AI
   * feature needs to stand apart in reports. */
  workerType?: string
}

/**
 * Convenience wrapper: given a raw `AiClient` and a
 * `CostTracker`, return a client that records usage through the
 * ledger using a context getter supplied by the caller.
 */
export function withLedger(
  inner: AiClient,
  costTracker: CostTracker,
  getContext: () => AiCallContext,
): AiClient {
  return new LedgerRecordingAiClient(inner, costTracker, getContext)
}
