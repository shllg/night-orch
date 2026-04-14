import { describe, it, expect } from 'vitest'
import { createMetricsRegistry } from '../../src/metrics/collectors.js'

describe('Metric definitions', () => {
  const metrics = createMetricsRegistry()

  it('all metrics have night_orch_ prefix', async () => {
    const json = await metrics.registry.getMetricsAsJSON()
    for (const metric of json) {
      expect(metric.name).toMatch(/^night_orch_/)
    }
  })

  it('all metrics have help text', async () => {
    const json = await metrics.registry.getMetricsAsJSON()
    for (const metric of json) {
      expect(metric.help).toBeTruthy()
    }
  })

  it('histogram buckets are sorted ascending', async () => {
    const json = await metrics.registry.getMetricsAsJSON()
    const histograms = json.filter((m) => m.type === 'histogram')
    expect(histograms.length).toBeGreaterThan(0)

    for (const hist of histograms) {
      // Extract bucket boundaries from le labels (prom-client stores them as numbers or strings)
      const bucketValues: number[] = []
      for (const val of hist.values) {
        if (val.labels && 'le' in val.labels) {
          const le = Number(val.labels.le)
          if (Number.isFinite(le)) {
            bucketValues.push(le)
          }
        }
      }
      // Verify buckets are sorted ascending
      for (let i = 1; i < bucketValues.length; i++) {
        expect(bucketValues[i]).toBeGreaterThanOrEqual(bucketValues[i - 1]!)
      }
    }
  })

  it('no duplicate metric names', async () => {
    const json = await metrics.registry.getMetricsAsJSON()
    const names = json.map((m) => m.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('contains all spec-required metrics', async () => {
    const json = await metrics.registry.getMetricsAsJSON()
    const names = json.map((m) => m.name)

    const required = [
      'night_orch_runs_total',
      'night_orch_loop_iterations_total',
      'night_orch_agent_invocations_total',
      'night_orch_pr_operations_total',
      'night_orch_verify_runs_total',
      'night_orch_notifications_total',
      'night_orch_active_runs',
      'night_orch_daily_cost_usd',
      'night_orch_eligible_issues',
      'night_orch_run_duration_seconds',
      'night_orch_phase_duration_seconds',
      'night_orch_agent_duration_seconds',
      'night_orch_verify_duration_seconds',
      'night_orch_build_info',
      'night_orch_rebase_conflict_total',
      'night_orch_rebase_auto_resolved_total',
      'night_orch_rebase_auto_resolve_failed_total',
    ]

    for (const name of required) {
      expect(names).toContain(name)
    }
  })
})
