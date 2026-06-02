import { Counter, Histogram, Gauge, Registry } from 'prom-client'
import { getBuildInfo } from '../utils/build-info.js'

export function createMetricsRegistry() {
  const buildVersion = getBuildInfo().version
  const buildCommit = process.env['GIT_SHA']?.trim() || 'unknown'
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

  const buildInfo = new Gauge({
    name: 'night_orch_build_info',
    help: 'Build metadata for metrics scrape diagnostics',
    labelNames: ['version', 'commit'] as const,
    registers: [registry],
  })
  buildInfo.set({ version: buildVersion, commit: buildCommit }, 1)

  /**
   * R4f: counts cost-ledger entries by their provenance tag. The
   * default production configuration should only ever increment the
   * `reported_cli` and `measured_api` labels; non-zero values on
   * `estimated_duration` or `fallback_zero` indicate that either a
   * worker failed to report token usage (and the operator has the
   * escape hatch on) or a code-path regression is writing untagged
   * rows. The `/api/cost/health` endpoint surfaces these counts as a
   * `fallbackRate24h` indicator so the operator sees degraded-
   * confidence cost data at a glance.
   */
  const costTokenSourceTotal = new Counter({
    name: 'night_orch_cost_token_source_total',
    help: 'Cost ledger entries by token-source provenance tag (reported_cli / measured_api / estimated_duration / fallback_zero)',
    labelNames: ['source'] as const,
    registers: [registry],
  })

  /**
   * Phase 4 gate metric (R5): number of rows currently in the
   * `checkpoint_quarantine` table. Should be zero under normal
   * operation; a non-zero value means phase_data corruption was
   * detected at crash recovery time and the operator should
   * inspect the row payloads to understand what went wrong. The
   * CLI `night-orch status` reads this gauge for its health line.
   */
  const checkpointQuarantineRows = new Gauge({
    name: 'night_orch_checkpoint_quarantine_rows',
    help: 'Rows currently in the checkpoint_quarantine table (0 = healthy)',
    registers: [registry],
  })

  /**
   * Phase 4 gate metric (R6): number of times the poller's circuit
   * breaker has tripped, i.e. skipped an issue because consecutive
   * blocked runs exceeded `loop.maxConsecutiveBlocks`. Should stay
   * near zero under normal operation; frequent trips mean an issue
   * is stuck in a loop and needs operator attention.
   */
  const circuitBreakerTripsTotal = new Counter({
    name: 'night_orch_circuit_breaker_trips_total',
    help: 'Circuit breaker trips by repo (consecutive blocked runs exceeded maxConsecutiveBlocks)',
    labelNames: ['repo'] as const,
    registers: [registry],
  })

  const rebaseConflictTotal = new Counter({
    name: 'night_orch_rebase_conflict_total',
    help: 'Rebase operations that encountered at least one textual conflict',
    registers: [registry],
  })

  const rebaseAutoResolvedTotal = new Counter({
    name: 'night_orch_rebase_auto_resolved_total',
    help: 'Rebase conflicts auto-resolved successfully',
    registers: [registry],
  })

  const rebaseAutoResolveFailedTotal = new Counter({
    name: 'night_orch_rebase_auto_resolve_failed_total',
    help: 'Rebase conflicts that failed auto-resolution by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  })

  const rebaseFanoutTotal = new Counter({
    name: 'night_orch_rebase_fanout_total',
    help: 'Merge fan-out events evaluated by repo and base branch',
    labelNames: ['repo', 'base_branch'] as const,
    registers: [registry],
  })

  const rebaseFanoutSiblingsTotal = new Counter({
    name: 'night_orch_rebase_fanout_siblings_total',
    help: 'Sibling PRs queued by merge fan-out by repo',
    labelNames: ['repo'] as const,
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
    buildInfo,
    costTokenSourceTotal,
    checkpointQuarantineRows,
    circuitBreakerTripsTotal,
    rebaseConflictTotal,
    rebaseAutoResolvedTotal,
    rebaseAutoResolveFailedTotal,
    rebaseFanoutTotal,
    rebaseFanoutSiblingsTotal,
  }
}

export type Metrics = ReturnType<typeof createMetricsRegistry>
