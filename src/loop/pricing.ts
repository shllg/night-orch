import type { Config } from '../config/schema.js'

interface TokenUsageInput {
  promptTokens: number
  completionTokens: number
}

interface ModelPricing {
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
  minuteUsd: number
}

interface CostConfigInput {
  model: Config['cost']['model']
  pricing?: Config['cost']['pricing']
}

export interface PricingIdentity {
  role: string
  workerType?: string | null
  pricingModel?: string | null
}

export interface EstimateWorkerCostInput {
  cost: CostConfigInput | undefined
  identity: PricingIdentity
  durationMs: number
  tokenUsage?: TokenUsageInput
}

const DEFAULT_MODEL_KEY = 'default'

const DEFAULT_PAY_PER_USE_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: 3,
  outputUsdPerMillionTokens: 15,
  minuteUsd: 0.008,
}

const DEFAULT_SUBSCRIPTION_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  minuteUsd: 0,
}

export function estimateWorkerCostUsd(input: EstimateWorkerCostInput): number {
  const costModel = input.cost?.model === 'subscription' ? 'subscription' : 'pay-per-use'
  const fallbackPricing = costModel === 'subscription'
    ? DEFAULT_SUBSCRIPTION_PRICING
    : DEFAULT_PAY_PER_USE_PRICING

  const configuredPricing = input.cost?.pricing
  const configuredDefaultModel = normalizeModelKey(configuredPricing?.defaultModel) ?? DEFAULT_MODEL_KEY
  const modelKey = resolveModelKey(input.identity, configuredDefaultModel)
  const modelPricing = resolveModelPricing(
    configuredPricing?.models ?? {},
    modelKey,
    configuredDefaultModel,
    fallbackPricing,
  )

  const usd = input.tokenUsage !== undefined
    ? estimateTokenCost(input.tokenUsage, modelPricing)
    : estimateDurationCost(input.durationMs, modelPricing.minuteUsd)

  return Number(Math.max(0, usd).toFixed(6))
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
): ModelPricing {
  const configured = models[modelKey] ?? models[defaultModel]
  if (!configured) return fallback

  return {
    inputUsdPerMillionTokens: configured.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: configured.outputUsdPerMillionTokens,
    minuteUsd: configured.minuteUsd,
  }
}

function estimateTokenCost(tokenUsage: TokenUsageInput, pricing: ModelPricing): number {
  const promptTokens = normalizeTokenCount(tokenUsage.promptTokens)
  const completionTokens = normalizeTokenCount(tokenUsage.completionTokens)
  return (
    (promptTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (completionTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
  )
}

function estimateDurationCost(durationMs: number, minuteUsd: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0
  return (durationMs / 60_000) * minuteUsd
}

function normalizeTokenCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function normalizeModelKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
