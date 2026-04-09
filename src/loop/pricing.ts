import type { Config } from '../config/schema.js'
import type { TokenUsage } from '../workers/types.js'

type TokenUsageInput = TokenUsage

interface ModelPricing {
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
  cacheReadUsdPerMillionTokens: number
  minuteUsd: number
}

interface CostConfigInput {
  model: Config['cost']['model']
  pricing?: Config['cost']['pricing']
}

/**
 * Identifies a worker for pricing lookup. The pricing system uses a cascade:
 * explicit pricingModel → workerType → role → configured default → builtin fallback.
 */
export interface PricingIdentity {
  role: string
  workerType?: string | null
  pricingModel?: string | null
  fallbackMinuteUsd?: number | null
}

/**
 * Input for estimating worker cost. All token counts are optional; when
 * provided, token-based pricing is used. Otherwise, duration-based pricing
 * applies.
 */
export interface EstimateWorkerCostInput {
  cost: CostConfigInput | undefined
  identity: PricingIdentity
  durationMs: number
  tokenUsage?: TokenUsageInput
  costModel?: Config['cost']['model']
}

/**
 * Result of a cost estimation. Includes the USD amount (zero for subscription
 * models) and metadata about which pricing configuration was selected.
 */
export interface EstimateWorkerCostResult {
  usd: number
  modelKey: string
  resolvedModelKey: string
  usedDefaultModelFallback: boolean
  usedProfileMinuteFallback: boolean
}

const DEFAULT_MODEL_KEY = 'default'

const DEFAULT_PAY_PER_USE_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: 3,
  outputUsdPerMillionTokens: 15,
  cacheReadUsdPerMillionTokens: 0.3,
  minuteUsd: 0.008,
}

/**
 * Estimate worker cost and return just the USD amount.
 * For subscription/subscription-metered models, returns 0.
 */
export function estimateWorkerCostUsd(input: EstimateWorkerCostInput): number {
  return estimateWorkerCost(input).usd
}

/**
 * Estimate worker cost based on token usage or duration.
 *
 * Pricing resolution cascade:
 * 1. If costModel is 'subscription' or 'subscription-metered' → returns $0 USD
 * 2. Otherwise, resolve model pricing from identity.pricingModel → identity.workerType → identity.role → default
 * 3. If tokenUsage provided → token-based calculation using resolved pricing
 * 4. Otherwise → duration-based calculation using per-minute rate
 *
 * The function returns detailed metadata about which pricing configuration was
 * selected to aid debugging of pricing mismatches.
 */
export function estimateWorkerCost(input: EstimateWorkerCostInput): EstimateWorkerCostResult {
  const fallbackPricing = DEFAULT_PAY_PER_USE_PRICING

  const configuredPricing = input.cost?.pricing
  const configuredDefaultModel = normalizeModelKey(configuredPricing?.defaultModel) ?? DEFAULT_MODEL_KEY
  const modelKey = resolveModelKey(input.identity, configuredDefaultModel)
  const resolvedPricing = resolveModelPricing(
    configuredPricing?.models ?? {},
    modelKey,
    configuredDefaultModel,
    fallbackPricing,
  )
  const modelPricing = resolvedPricing.pricing

  const profileMinuteUsd = normalizeMinuteUsd(input.identity.fallbackMinuteUsd)
  const minuteUsd = profileMinuteUsd ?? modelPricing.minuteUsd

  // Subscription models charge no per-token/per-minute fees — return $0 USD
  // while still tracking token counts for analytics.
  const costModel = input.costModel ?? input.cost?.model ?? 'pay-per-use'
  if (costModel === 'subscription' || costModel === 'subscription-metered') {
    return {
      usd: 0,
      modelKey,
      resolvedModelKey: resolvedPricing.resolvedModelKey,
      usedDefaultModelFallback: resolvedPricing.usedDefaultModelFallback,
      usedProfileMinuteFallback: profileMinuteUsd !== null,
    }
  }

  const usd = input.tokenUsage !== undefined
    ? estimateTokenCost(input.tokenUsage, modelPricing)
    : estimateDurationCost(input.durationMs, minuteUsd)

  return {
    usd: Number(Math.max(0, usd).toFixed(6)),
    modelKey,
    resolvedModelKey: resolvedPricing.resolvedModelKey,
    usedDefaultModelFallback: resolvedPricing.usedDefaultModelFallback,
    usedProfileMinuteFallback: profileMinuteUsd !== null,
  }
}

function resolveModelKey(identity: PricingIdentity, defaultModel: string): string {
  return (
    normalizeModelKey(identity.pricingModel) ??
    normalizeModelKey(identity.workerType) ??
    normalizeModelKey(identity.role) ??
    defaultModel
  )
}

function resolveModelPricing(
  models: Record<string, ModelPricing>,
  modelKey: string,
  defaultModel: string,
  fallback: ModelPricing,
): { pricing: ModelPricing; resolvedModelKey: string; usedDefaultModelFallback: boolean } {
  const direct = models[modelKey]
  if (direct) {
    return {
      pricing: normalizeModelPricing(direct),
      resolvedModelKey: modelKey,
      usedDefaultModelFallback: false,
    }
  }

  const defaultEntry = models[defaultModel]
  if (defaultEntry) {
    return {
      pricing: normalizeModelPricing(defaultEntry),
      resolvedModelKey: defaultModel,
      usedDefaultModelFallback: modelKey !== defaultModel,
    }
  }

  return {
    pricing: normalizeModelPricing(fallback),
    resolvedModelKey: 'builtin-default',
    usedDefaultModelFallback: false,
  }
}

function estimateTokenCost(tokenUsage: TokenUsageInput, pricing: ModelPricing): number {
  const promptTokens = normalizeTokenCount(tokenUsage.promptTokens)
  const completionTokens = normalizeTokenCount(tokenUsage.completionTokens)
  const cacheReadTokens = normalizeTokenCount(tokenUsage.cacheReadTokens)
  return (
    (promptTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (completionTokens / 1_000_000) * pricing.outputUsdPerMillionTokens +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadUsdPerMillionTokens
  )
}

function estimateDurationCost(durationMs: number, minuteUsd: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0
  return (durationMs / 60_000) * minuteUsd
}

function normalizeTokenCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function normalizeModelKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeModelPricing(value: Partial<ModelPricing>): ModelPricing {
  const inputUsdPerMillionTokens = normalizeNonNegativeNumber(
    value.inputUsdPerMillionTokens,
    DEFAULT_PAY_PER_USE_PRICING.inputUsdPerMillionTokens,
  )
  const outputUsdPerMillionTokens = normalizeNonNegativeNumber(
    value.outputUsdPerMillionTokens,
    DEFAULT_PAY_PER_USE_PRICING.outputUsdPerMillionTokens,
  )
  const minuteUsd = normalizeNonNegativeNumber(
    value.minuteUsd,
    DEFAULT_PAY_PER_USE_PRICING.minuteUsd,
  )
  const cacheReadUsdPerMillionTokens = normalizeNonNegativeNumber(
    value.cacheReadUsdPerMillionTokens,
    Number((inputUsdPerMillionTokens * 0.1).toFixed(6)),
  )

  return {
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    cacheReadUsdPerMillionTokens,
    minuteUsd,
  }
}

function normalizeMinuteUsd(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return value
}
