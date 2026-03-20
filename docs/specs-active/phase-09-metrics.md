# Phase 9: Prometheus Metrics + Observability

## Objective

Expose Prometheus metrics via `prom-client` for monitoring run outcomes, durations, costs, and system health. This phase runs in parallel with Phases 2-8 (only depends on Phase 1 for config and logger).

## Dependencies

- **Phase 1**: Config (`metrics.enabled`, `metrics.port`, `metrics.host`), logger.
- **Integration points**: As other phases land, they call `metrics.inc()` / `metrics.observe()` at key points. Metric recording is always best-effort (never blocks main flow).

## Inputs

- Metrics config (enabled, port, host)
- Runtime data from loop execution, verification, publishing, etc.

## Outputs

- HTTP server serving `/metrics` endpoint in Prometheus exposition format
- Metric recording functions callable from any module
- Grafana dashboard definition (JSON file, not deployed)

---

## Interfaces / Types

### Metrics Registry

```typescript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

interface MetricsService {
  /** Initialize the metrics registry and HTTP server.
   *  No-op if metrics.enabled is false. */
  start(): Promise<void>;

  /** Graceful shutdown of metrics HTTP server. */
  stop(): Promise<void>;

  /** Get the registry (for testing or custom metrics). */
  getRegistry(): Registry;

  // --- Counters ---

  /** Increment runs total by status. */
  incRunsTotal(status: 'completed' | 'blocked' | 'error'): void;

  /** Increment agent invocations by role and adapter type. */
  incAgentInvocations(role: 'planner' | 'coder' | 'reviewer', adapter: 'claude' | 'codex'): void;

  /** Increment loop iterations (review bounces). */
  incLoopIterations(repo: string): void;

  /** Increment verification runs by result. */
  incVerifyRuns(result: 'pass' | 'fail'): void;

  /** Increment PR operations by type. */
  incPROperations(type: 'created' | 'updated'): void;

  /** Increment notifications by channel and result. */
  incNotifications(channel: string, result: 'sent' | 'failed'): void;

  // --- Histograms ---

  /** Observe total run duration. */
  observeRunDuration(durationSeconds: number): void;

  /** Observe individual phase duration. */
  observePhaseDuration(phase: string, durationSeconds: number): void;

  /** Observe agent invocation duration. */
  observeAgentDuration(role: string, adapter: string, durationSeconds: number): void;

  /** Observe verification command duration. */
  observeVerifyDuration(durationSeconds: number): void;

  // --- Gauges ---

  /** Set active runs count. */
  setActiveRuns(count: number): void;

  /** Set daily cost gauge. */
  setDailyCost(costUsd: number): void;

  /** Set eligible issues count per repo. */
  setEligibleIssues(repo: string, count: number): void;
}
```

### Metric Definitions

```typescript
const METRICS = {
  // Counters
  runs_total: new Counter({
    name: 'night_orch_runs_total',
    help: 'Total number of runs by final status',
    labelNames: ['status'] as const,
  }),

  agent_invocations_total: new Counter({
    name: 'night_orch_agent_invocations_total',
    help: 'Total agent invocations by role and adapter',
    labelNames: ['role', 'adapter'] as const,
  }),

  loop_iterations_total: new Counter({
    name: 'night_orch_loop_iterations_total',
    help: 'Total loop iterations (review bounces)',
    labelNames: ['repo'] as const,
  }),

  verify_runs_total: new Counter({
    name: 'night_orch_verify_runs_total',
    help: 'Verification command runs by result',
    labelNames: ['result'] as const,
  }),

  pr_operations_total: new Counter({
    name: 'night_orch_pr_operations_total',
    help: 'PR create/update operations',
    labelNames: ['type'] as const,
  }),

  notifications_total: new Counter({
    name: 'night_orch_notifications_total',
    help: 'Notifications sent by channel and result',
    labelNames: ['channel', 'result'] as const,
  }),

  // Histograms
  run_duration_seconds: new Histogram({
    name: 'night_orch_run_duration_seconds',
    help: 'Total run duration in seconds',
    buckets: [60, 300, 600, 1200, 1800, 3600, 7200],
  }),

  phase_duration_seconds: new Histogram({
    name: 'night_orch_phase_duration_seconds',
    help: 'Duration per loop phase in seconds',
    labelNames: ['phase'] as const,
    buckets: [10, 30, 60, 120, 300, 600, 1800],
  }),

  agent_duration_seconds: new Histogram({
    name: 'night_orch_agent_duration_seconds',
    help: 'Agent invocation duration in seconds',
    labelNames: ['role', 'adapter'] as const,
    buckets: [30, 60, 120, 300, 600, 1200, 1800],
  }),

  verify_duration_seconds: new Histogram({
    name: 'night_orch_verify_duration_seconds',
    help: 'Verification command duration in seconds',
    buckets: [5, 15, 30, 60, 120, 300],
  }),

  // Gauges
  active_runs: new Gauge({
    name: 'night_orch_active_runs',
    help: 'Number of currently active runs',
  }),

  daily_cost_usd: new Gauge({
    name: 'night_orch_daily_cost_usd',
    help: 'Estimated daily cost in USD',
  }),

  eligible_issues: new Gauge({
    name: 'night_orch_eligible_issues',
    help: 'Number of eligible issues per repo',
    labelNames: ['repo'] as const,
  }),
} as const;
```

---

## Config Schema Additions

Already defined in Phase 1:

```yaml
metrics:
  enabled: true
  port: 9090
  host: 127.0.0.1
```

---

## Files to Create

```
src/
  metrics/
    service.ts             — MetricsService: registry, HTTP server, metric methods
    definitions.ts         — All Counter/Histogram/Gauge definitions
    middleware.ts          — Express-less HTTP handler for /metrics endpoint
  grafana/
    dashboard.json         — Grafana dashboard definition (import-ready)
```

### File Descriptions

- **`metrics/service.ts`**: Singleton `MetricsService`. Creates registry with all metrics from `definitions.ts`. Starts `http.createServer` on configured port. Serves `/metrics` with `registry.metrics()`. All `inc*` / `observe*` / `set*` methods are no-ops when `metrics.enabled` is false. Never throws on metric recording failure.
- **`metrics/definitions.ts`**: All metric objects (Counter, Histogram, Gauge) with proper names, help text, labels, and buckets. Uses `night_orch_` prefix for all metric names.
- **`metrics/middleware.ts`**: Simple `http.createServer` handler. Only responds to `GET /metrics`. Returns 200 with `text/plain; charset=utf-8` and registry output. Returns 404 for other paths. No Express dependency.
- **`grafana/dashboard.json`**: Pre-built Grafana dashboard with panels:
  - Runs by status (counter rate)
  - Run duration histogram
  - Active runs gauge
  - Agent invocation rates by role/adapter
  - Loop iteration rate
  - Daily cost gauge
  - Eligible issues by repo
  - Verification pass/fail rate
  - Notification success/failure rate

---

## Integration Points

Metrics calls are added to other modules as they're implemented. The pattern is:

```typescript
// In loop/engine.ts
import { metrics } from '../metrics/service.js';

// After run completes:
metrics.incRunsTotal(finalStatus);
metrics.observeRunDuration(durationSeconds);

// After each phase:
metrics.observePhaseDuration(phase, durationSeconds);
```

Key integration points (added by respective phases):
- **Phase 2**: `setEligibleIssues` after discovery
- **Phase 4**: `incAgentInvocations`, `observeAgentDuration` after worker calls
- **Phase 5**: `incLoopIterations`, `observeRunDuration`, `observePhaseDuration`, `incRunsTotal`, `setActiveRuns`, `setDailyCost`
- **Phase 6**: `incPROperations`, `incVerifyRuns`, `observeVerifyDuration`
- **Phase 7**: `incNotifications` after dispatch

---

## Tests

### Metrics Service Tests (`test/metrics/service.test.ts`)
- Metrics disabled → all methods are no-ops, no server started
- Metrics enabled → server starts on configured port
- `/metrics` returns valid Prometheus exposition format
- Non-`/metrics` path returns 404
- Counter increment reflected in output
- Histogram observation reflected in output
- Gauge set reflected in output
- Graceful stop closes server

### Metric Definitions Tests (`test/metrics/definitions.test.ts`)
- All metrics have `night_orch_` prefix
- All metrics have help text
- Histogram buckets are sorted ascending
- No duplicate metric names

### Integration Test (`test/metrics/integration.test.ts`)
- Start service → record metrics → scrape `/metrics` → verify values
- Concurrent metric recording is safe (no crashes)

---

## Acceptance Criteria

1. `/metrics` endpoint serves valid Prometheus exposition format
2. All defined counters, histograms, and gauges are present in output
3. Metrics disabled → no server started, no errors
4. Metrics recording is always best-effort (never blocks main flow)
5. Grafana dashboard JSON importable and shows meaningful panels
6. `night_orch_` prefix on all metric names
7. Histogram buckets appropriate for expected durations
8. All tests pass: `pnpm test`
