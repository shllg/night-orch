import { describe, expect, it } from 'vitest'
import { estimateWorkerCostUsd } from '../../src/loop/pricing.js'

describe('estimateWorkerCostUsd', () => {
  it('uses default pay-per-use token rates', () => {
    const usd = estimateWorkerCostUsd({
      cost: { model: 'pay-per-use' },
      identity: { role: 'planner', workerType: 'claude' },
      durationMs: 1_000,
      tokenUsage: { promptTokens: 1_000, completionTokens: 500 },
    })

    expect(usd).toBe(0.0105)
  })

  it('returns $0 USD for subscription cost model regardless of token usage', () => {
    const usd = estimateWorkerCostUsd({
      cost: { model: 'subscription' },
      identity: { role: 'coder', workerType: 'codex' },
      durationMs: 10_000,
      tokenUsage: { promptTokens: 25_000, completionTokens: 8_000 },
    })

    expect(usd).toBe(0)
  })

  it('returns $0 USD for subscription cost model even with configured pricing', () => {
    const usd = estimateWorkerCostUsd({
      cost: {
        model: 'subscription',
        pricing: {
          defaultModel: 'fallback',
          models: {
            fallback: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0, minuteUsd: 0 },
            'gpt-5': { inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 20, minuteUsd: 0.5 },
          },
        },
      },
      identity: { role: 'reviewer', workerType: 'codex', pricingModel: 'gpt-5' },
      durationMs: 5_000,
      tokenUsage: { promptTokens: 1_000, completionTokens: 1_000 },
    })

    expect(usd).toBe(0)
  })

  it('falls back to minute pricing when token usage is unavailable', () => {
    const usd = estimateWorkerCostUsd({
      cost: { model: 'pay-per-use' },
      identity: { role: 'planner', workerType: 'claude' },
      durationMs: 60_000,
    })

    expect(usd).toBe(0.008)
  })

  it('uses configured default model when worker model key has no direct pricing entry', () => {
    const usd = estimateWorkerCostUsd({
      cost: {
        model: 'pay-per-use',
        pricing: {
          defaultModel: 'shared-default',
          models: {
            'shared-default': { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 4, minuteUsd: 0.25 },
          },
        },
      },
      identity: { role: 'planner', workerType: 'unknown-model' },
      durationMs: 120_000,
    })

    expect(usd).toBe(0.5)
  })

  it('returns $0 USD for subscription cost model regardless of token usage', () => {
    const usd = estimateWorkerCostUsd({
      cost: { model: 'subscription' },
      identity: { role: 'coder', workerType: 'claude' },
      durationMs: 60_000,
      tokenUsage: { promptTokens: 1_000_000, completionTokens: 500_000 },
    })

    expect(usd).toBe(0)
  })

  it('returns $0 USD for subscription-metered cost model regardless of token usage', () => {
    const usd = estimateWorkerCostUsd({
      cost: { model: 'subscription-metered' },
      identity: { role: 'coder', workerType: 'codex' },
      durationMs: 60_000,
      tokenUsage: { promptTokens: 2_000_000, completionTokens: 1_000_000 },
    })

    expect(usd).toBe(0)
  })

  it('accepts costModel parameter directly (bypassing cost.model)', () => {
    const usd = estimateWorkerCostUsd({
      cost: { model: 'pay-per-use' },
      costModel: 'subscription',
      identity: { role: 'planner', workerType: 'claude' },
      durationMs: 60_000,
      tokenUsage: { promptTokens: 1_000_000, completionTokens: 500_000 },
    })

    expect(usd).toBe(0)
  })
})
