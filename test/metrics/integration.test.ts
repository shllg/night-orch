import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMetricsService, type MetricsService } from '../../src/metrics/service.js'
import http from 'node:http'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function getMetrics(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/metrics`, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

describe('Metrics integration', () => {
  let service: MetricsService
  let port: number

  afterEach(async () => {
    if (service) {
      await service.stop()
    }
  })

  it('start → record metrics → scrape → verify values', async () => {
    service = createMetricsService({ enabled: true, host: '127.0.0.1', port: 0 })
    await service.start()
    port = service.endpoint!.port

    // Record various metrics
    service.incRunsTotal('completed')
    service.incRunsTotal('error')
    service.incAgentInvocations('planner', 'claude')
    service.incLoopIterations('org/repo')
    service.incVerifyRuns('pass')
    service.incPROperations('created')
    service.incNotifications('console', 'sent')
    service.incRebaseConflict()
    service.incRebaseAutoResolved()
    service.incRebaseAutoResolveFailed('error')
    service.observeRunDuration(300)
    service.observePhaseDuration('plan', 45)
    service.observeAgentDuration('planner', 'claude', 60)
    service.observeVerifyDuration(15)
    service.setActiveRuns(2)
    service.setDailyCost(7.5)
    service.setEligibleIssues('org/repo', 5)

    // Scrape
    const body = await getMetrics(port)

    // Verify counters
    expect(body).toContain('night_orch_runs_total{status="completed"} 1')
    expect(body).toContain('night_orch_runs_total{status="error"} 1')
    expect(body).toContain('night_orch_agent_invocations_total{role="planner",adapter="claude"} 1')
    expect(body).toContain('night_orch_loop_iterations_total{repo="org/repo"} 1')
    expect(body).toContain('night_orch_verify_runs_total{result="pass"} 1')
    expect(body).toContain('night_orch_pr_operations_total{type="created"} 1')
    expect(body).toContain('night_orch_notifications_total{channel="console",result="sent"} 1')
    expect(body).toContain('night_orch_rebase_conflict_total 1')
    expect(body).toContain('night_orch_rebase_auto_resolved_total 1')
    expect(body).toContain('night_orch_rebase_auto_resolve_failed_total{reason="error"} 1')

    // Verify histograms
    expect(body).toContain('night_orch_run_duration_seconds_count 1')
    expect(body).toContain('night_orch_phase_duration_seconds_count{phase="plan"} 1')
    expect(body).toContain('night_orch_agent_duration_seconds_count{role="planner",adapter="claude"} 1')
    expect(body).toContain('night_orch_verify_duration_seconds_count 1')

    // Verify gauges
    expect(body).toContain('night_orch_active_runs 2')
    expect(body).toContain('night_orch_daily_cost_usd 7.5')
    expect(body).toContain('night_orch_eligible_issues{repo="org/repo"} 5')
  })

  it('concurrent metric recording is safe', async () => {
    service = createMetricsService({ enabled: true, host: '127.0.0.1', port: 0 })
    await service.start()
    port = service.endpoint!.port

    // Fire many concurrent increments
    const promises: Promise<void>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(
        Promise.resolve().then(() => {
          service.incRunsTotal('completed')
          service.incLoopIterations('org/repo')
          service.observeRunDuration(i)
        }),
      )
    }

    await Promise.all(promises)

    const body = await getMetrics(port)
    expect(body).toContain('night_orch_runs_total{status="completed"} 100')
    expect(body).toContain('night_orch_loop_iterations_total{repo="org/repo"} 100')
    expect(body).toContain('night_orch_run_duration_seconds_count 100')
  })
})
