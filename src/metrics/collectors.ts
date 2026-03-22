import { Counter, Histogram, Gauge, Registry } from 'prom-client'

export function createMetricsRegistry() {
  const registry = new Registry()

  const runsTotal = new Counter({
    name: 'night_orch_runs_total',
    help: 'Total runs by outcome',
    labelNames: ['status'] as const,
    registers: [registry],
  })

  const issuesProcessed = new Counter({
    name: 'night_orch_issues_processed_total',
    help: 'Issues processed',
    labelNames: ['repo'] as const,
    registers: [registry],
  })

  const loopIterations = new Counter({
    name: 'night_orch_loop_iterations_total',
    help: 'Plan/code/review iterations',
    labelNames: ['repo'] as const,
    registers: [registry],
  })

  const agentInvocations = new Counter({
    name: 'night_orch_agent_invocations_total',
    help: 'Agent calls by role and adapter',
    labelNames: ['role', 'adapter'] as const,
    registers: [registry],
  })

  const prOperations = new Counter({
    name: 'night_orch_pr_operations_total',
    help: 'PR operations by type',
    labelNames: ['type'] as const,
    registers: [registry],
  })

  const verifyRunsTotal = new Counter({
    name: 'night_orch_verify_runs_total',
    help: 'Verification runs by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const notificationsTotal = new Counter({
    name: 'night_orch_notifications_total',
    help: 'Notifications sent by channel and result',
    labelNames: ['channel', 'result'] as const,
    registers: [registry],
  })

  const errorsTotal = new Counter({
    name: 'night_orch_errors_total',
    help: 'Errors by category',
    labelNames: ['repo', 'error_type'] as const,
    registers: [registry],
  })

  const activeRuns = new Gauge({
    name: 'night_orch_active_runs',
    help: 'Currently running',
    registers: [registry],
  })

  const queuedIssues = new Gauge({
    name: 'night_orch_queued_issues',
    help: 'Eligible issues waiting',
    registers: [registry],
  })

  const blockedIssues = new Gauge({
    name: 'night_orch_blocked_issues',
    help: 'Blocked issues',
    registers: [registry],
  })

  const dailyCostUsd = new Gauge({
    name: 'night_orch_daily_cost_usd',
    help: 'Estimated daily API cost in USD',
    registers: [registry],
  })

  const eligibleIssues = new Gauge({
    name: 'night_orch_eligible_issues',
    help: 'Eligible issues by repo',
    labelNames: ['repo'] as const,
    registers: [registry],
  })

  const runDuration = new Histogram({
    name: 'night_orch_run_duration_seconds',
    help: 'Time per run',
    buckets: [60, 300, 600, 1200, 1800, 3600, 7200],
    registers: [registry],
  })

  const phaseDuration = new Histogram({
    name: 'night_orch_phase_duration_seconds',
    help: 'Time per loop phase',
    labelNames: ['phase'] as const,
    buckets: [10, 30, 60, 120, 300, 600, 1800],
    registers: [registry],
  })

  const agentDuration = new Histogram({
    name: 'night_orch_agent_duration_seconds',
    help: 'Time per agent call',
    labelNames: ['role', 'adapter'] as const,
    buckets: [30, 60, 120, 300, 600, 1200, 1800],
    registers: [registry],
  })

  const verifyDuration = new Histogram({
    name: 'night_orch_verify_duration_seconds',
    help: 'Time per verification run',
    buckets: [5, 15, 30, 60, 120, 300],
    registers: [registry],
  })

  const estimatedCost = new Counter({
    name: 'night_orch_estimated_cost_dollars',
    help: 'Estimated API cost',
    labelNames: ['repo', 'agent'] as const,
    registers: [registry],
  })

  return {
    registry,
    runsTotal,
    issuesProcessed,
    loopIterations,
    agentInvocations,
    prOperations,
    verifyRunsTotal,
    notificationsTotal,
    errorsTotal,
    activeRuns,
    queuedIssues,
    blockedIssues,
    dailyCostUsd,
    eligibleIssues,
    runDuration,
    phaseDuration,
    agentDuration,
    verifyDuration,
    estimatedCost,
  }
}

export type Metrics = ReturnType<typeof createMetricsRegistry>
