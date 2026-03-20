import { Counter, Histogram, Gauge, Registry } from 'prom-client'

export function createMetricsRegistry() {
  const registry = new Registry()

  const runsTotal = new Counter({
    name: 'night_orch_runs_total',
    help: 'Total runs by outcome',
    labelNames: ['repo', 'status'] as const,
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
    help: 'Agent calls by type and role',
    labelNames: ['agent', 'role'] as const,
    registers: [registry],
  })

  const prCreated = new Counter({
    name: 'night_orch_pr_created_total',
    help: 'PRs created',
    labelNames: ['repo'] as const,
    registers: [registry],
  })

  const prUpdated = new Counter({
    name: 'night_orch_pr_updated_total',
    help: 'PRs updated',
    labelNames: ['repo'] as const,
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
    labelNames: ['repo'] as const,
    registers: [registry],
  })

  const queuedIssues = new Gauge({
    name: 'night_orch_queued_issues',
    help: 'Eligible issues waiting',
    labelNames: ['repo'] as const,
    registers: [registry],
  })

  const blockedIssues = new Gauge({
    name: 'night_orch_blocked_issues',
    help: 'Blocked issues',
    labelNames: ['repo'] as const,
    registers: [registry],
  })

  const runDuration = new Histogram({
    name: 'night_orch_run_duration_seconds',
    help: 'Time per run',
    labelNames: ['repo', 'status'] as const,
    buckets: [60, 300, 600, 1200, 1800, 3600, 7200],
    registers: [registry],
  })

  const agentDuration = new Histogram({
    name: 'night_orch_agent_duration_seconds',
    help: 'Time per agent call',
    labelNames: ['agent', 'role'] as const,
    buckets: [30, 60, 120, 300, 600, 1200, 1800],
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
    prCreated,
    prUpdated,
    errorsTotal,
    activeRuns,
    queuedIssues,
    blockedIssues,
    runDuration,
    agentDuration,
    estimatedCost,
  }
}

export type Metrics = ReturnType<typeof createMetricsRegistry>
