import type Database from 'better-sqlite3'
import { RunManager, type RunStatus } from '../../state/runs.js'
import { insertRunLogEvents, type RunLogEventRecord, type RunLogSource } from '../../state/run-log-events.js'

interface DemoRunSpec {
  repo: string
  issueNumber: number
  title: string
  status: RunStatus
  phase: string | null
  iterations: number
  costUsd: number
  promptTokens: number
  completionTokens: number
  prNumber: number | null
  prTitle: string | null
  lastError: string | null
  startOffsetMinutes: number
  durationMinutes: number | null
  events: DemoEvent[]
}

interface DemoEvent {
  source: RunLogSource
  phase: string | null
  role: string | null
  type: string
  message: string
  offsetSeconds: number
}

const NOW = Date.now()

const RUN_SPECS: DemoRunSpec[] = [
  {
    repo: 'acme/web-app',
    issueNumber: 142,
    title: 'Extract pricing card into reusable component',
    status: 'running',
    phase: 'code',
    iterations: 2,
    costUsd: 1.84,
    promptTokens: 42_130,
    completionTokens: 8_960,
    prNumber: null,
    prTitle: null,
    lastError: null,
    startOffsetMinutes: -18,
    durationMinutes: null,
    events: [
      { source: 'system', phase: 'plan', role: null, type: 'phase_start', message: 'phase_start: plan', offsetSeconds: 0 },
      { source: 'agent', phase: 'plan', role: 'claude', type: 'agent_output', message: 'Reading issue body and scanning src/components/pricing.', offsetSeconds: 4 },
      { source: 'agent', phase: 'plan', role: 'claude', type: 'agent_output', message: 'Plan: extract <PricingCard /> into a reusable primitive under components/pricing-card/.', offsetSeconds: 42 },
      { source: 'system', phase: 'plan', role: null, type: 'phase_complete', message: 'phase_complete: plan (42.1s)', offsetSeconds: 43 },
      { source: 'system', phase: 'code', role: null, type: 'phase_start', message: 'phase_start: code', offsetSeconds: 44 },
      { source: 'agent', phase: 'code', role: 'claude', type: 'agent_output', message: 'Created src/components/pricing-card/pricing-card.web.tsx', offsetSeconds: 98 },
      { source: 'agent', phase: 'code', role: 'claude', type: 'agent_output', message: 'Wired stories + updated barrel exports.', offsetSeconds: 122 },
      { source: 'agent', phase: 'code', role: 'claude', type: 'agent_output', message: 'Running pnpm typecheck…', offsetSeconds: 155 },
    ],
  },
  {
    repo: 'acme/web-app',
    issueNumber: 138,
    title: 'Migrate settings page selects to design system',
    status: 'review_ready',
    phase: 'review',
    iterations: 3,
    costUsd: 0.92,
    promptTokens: 22_450,
    completionTokens: 5_110,
    prNumber: 412,
    prTitle: '[REFACTOR] Settings selects → SelectWeb',
    lastError: null,
    startOffsetMinutes: -128,
    durationMinutes: 24,
    events: [
      { source: 'system', phase: 'plan', role: null, type: 'phase_start', message: 'phase_start: plan', offsetSeconds: 0 },
      { source: 'agent', phase: 'plan', role: 'claude', type: 'agent_output', message: 'Identified 3 raw <select> usages in SettingsPage.', offsetSeconds: 15 },
      { source: 'system', phase: 'code', role: null, type: 'phase_complete', message: 'phase_complete: code — PR #412 opened', offsetSeconds: 820 },
      { source: 'system', phase: 'review', role: null, type: 'review_ready', message: 'review_ready: awaiting human approval', offsetSeconds: 1420 },
    ],
  },
  {
    repo: 'acme/api-service',
    issueNumber: 77,
    title: 'Add rate-limiting middleware with burst allowance',
    status: 'blocked',
    phase: 'verify',
    iterations: 4,
    costUsd: 3.41,
    promptTokens: 78_220,
    completionTokens: 14_080,
    prNumber: 203,
    prTitle: '[FEATURE] Rate-limiting middleware',
    lastError: 'Verification failed: 3 integration tests timing out under load (timeout=30s)',
    startOffsetMinutes: -245,
    durationMinutes: null,
    events: [
      { source: 'system', phase: 'verify', role: null, type: 'phase_start', message: 'phase_start: verify', offsetSeconds: 0 },
      { source: 'agent', phase: 'verify', role: 'codex', type: 'agent_output', message: 'Running integration test suite…', offsetSeconds: 12 },
      { source: 'agent', phase: 'verify', role: 'codex', type: 'agent_output', message: 'FAIL test/middleware/rate-limit.test.ts — 3 tests timing out', offsetSeconds: 980 },
      { source: 'system', phase: 'verify', role: null, type: 'blocked', message: 'Run blocked: verification_failed', offsetSeconds: 985 },
    ],
  },
  {
    repo: 'acme/api-service',
    issueNumber: 72,
    title: 'Document authentication flow with sequence diagrams',
    status: 'completed',
    phase: null,
    iterations: 2,
    costUsd: 0.48,
    promptTokens: 14_620,
    completionTokens: 3_250,
    prNumber: 198,
    prTitle: '[DOCS] Authentication flow + diagrams',
    lastError: null,
    startOffsetMinutes: -1440,
    durationMinutes: 18,
    events: [
      { source: 'system', phase: 'plan', role: null, type: 'phase_start', message: 'phase_start: plan', offsetSeconds: 0 },
      { source: 'agent', phase: 'code', role: 'claude', type: 'agent_output', message: 'Added docs/auth-flow.md with mermaid sequence diagrams.', offsetSeconds: 520 },
      { source: 'system', phase: null, role: null, type: 'completed', message: 'Run completed — PR #198 merged', offsetSeconds: 1080 },
    ],
  },
  {
    repo: 'acme/web-app',
    issueNumber: 131,
    title: 'Refactor dashboard nav to shared NavMenu primitive',
    status: 'completed',
    phase: null,
    iterations: 1,
    costUsd: 0.65,
    promptTokens: 18_200,
    completionTokens: 4_100,
    prNumber: 405,
    prTitle: '[REFACTOR] DashboardNavigation → NavMenuWeb + NavDockWeb',
    lastError: null,
    startOffsetMinutes: -2880,
    durationMinutes: 22,
    events: [
      { source: 'system', phase: 'plan', role: null, type: 'phase_start', message: 'phase_start: plan', offsetSeconds: 0 },
      { source: 'agent', phase: 'code', role: 'claude', type: 'agent_output', message: 'Wired NavMenuWeb + NavDockWeb into DashboardNavigation.', offsetSeconds: 600 },
      { source: 'system', phase: null, role: null, type: 'completed', message: 'Run completed — PR #405 merged', offsetSeconds: 1320 },
    ],
  },
  {
    repo: 'acme/web-app',
    issueNumber: 156,
    title: 'Storybook overview page for design system tokens',
    status: 'queued',
    phase: null,
    iterations: 0,
    costUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    prNumber: null,
    prTitle: null,
    lastError: null,
    startOffsetMinutes: -3,
    durationMinutes: null,
    events: [],
  },
  {
    repo: 'acme/api-service',
    issueNumber: 81,
    title: 'Investigate intermittent 502 on /v1/ingest',
    status: 'error',
    phase: 'plan',
    iterations: 1,
    costUsd: 0.18,
    promptTokens: 5_800,
    completionTokens: 920,
    prNumber: null,
    prTitle: null,
    lastError: 'Agent exited non-zero: ENOENT spawn docker-compose (dedicated env setup failed)',
    startOffsetMinutes: -92,
    durationMinutes: 2,
    events: [
      { source: 'system', phase: 'plan', role: null, type: 'phase_start', message: 'phase_start: plan', offsetSeconds: 0 },
      { source: 'system', phase: 'plan', role: null, type: 'error', message: 'docker-compose not available — dedicated env setup failed', offsetSeconds: 45 },
    ],
  },
  {
    repo: 'acme/web-app',
    issueNumber: 160,
    title: 'Dark mode audit on mobile viewports',
    status: 'running',
    phase: 'plan',
    iterations: 1,
    costUsd: 0.21,
    promptTokens: 6_240,
    completionTokens: 1_180,
    prNumber: null,
    prTitle: null,
    lastError: null,
    startOffsetMinutes: -6,
    durationMinutes: null,
    events: [
      { source: 'system', phase: 'plan', role: null, type: 'phase_start', message: 'phase_start: plan', offsetSeconds: 0 },
      { source: 'agent', phase: 'plan', role: 'claude', type: 'agent_output', message: 'Scanning stories for mobile viewport coverage…', offsetSeconds: 8 },
    ],
  },
]

/**
 * Seed the demo database with a varied set of runs, issues, and log
 * events. Safe to call on an empty DB; does nothing if runs already
 * exist (demo command always starts with a fresh temp DB so this is a
 * belt-and-suspenders guard).
 */
export function seedDemoData(db: Database.Database): { runCount: number; eventCount: number } {
  const existing = db.prepare('SELECT COUNT(*) as c FROM runs').get() as { c: number }
  if (existing.c > 0) {
    return { runCount: 0, eventCount: 0 }
  }

  const runManager = new RunManager(db)
  let eventCount = 0

  for (const spec of RUN_SPECS) {
    const startedAt = isoAt(NOW + spec.startOffsetMinutes * 60_000)
    const endedAt = spec.durationMinutes !== null
      ? isoAt(NOW + (spec.startOffsetMinutes + spec.durationMinutes) * 60_000)
      : null

    const run = runManager.create({
      repo: spec.repo,
      issueNumber: spec.issueNumber,
      issueTitle: spec.title,
      issueNodeId: `I_demo_${spec.repo.replace('/', '_')}_${spec.issueNumber}`,
      planner: 'claude-default',
      coder: 'claude-default',
      reviewer: 'claude-default',
    })

    runManager.update(run.id, {
      status: spec.status,
      currentPhase: spec.phase,
      iterationCount: spec.iterations,
      estimatedCostUsd: spec.costUsd,
      theoreticalCostUsd: spec.costUsd,
      promptTokens: spec.promptTokens,
      completionTokens: spec.completionTokens,
      prNumber: spec.prNumber,
      prTitle: spec.prTitle,
      lastError: spec.lastError,
      startedAt,
      endedAt,
      branchName: spec.prNumber !== null ? `orch/${spec.repo.split('/')[1]}/${spec.issueNumber}` : null,
      branchSlug: spec.prNumber !== null ? `${spec.issueNumber}-demo` : null,
    })

    if (spec.events.length > 0) {
      const baseMs = NOW + spec.startOffsetMinutes * 60_000
      const events = spec.events.map((event): Omit<RunLogEventRecord, 'id'> => ({
        runId: run.id,
        source: event.source,
        phase: event.phase,
        role: event.role,
        type: event.type,
        data: { message: event.message },
        timestamp: isoAt(baseMs + event.offsetSeconds * 1000),
      }))
      insertRunLogEvents(db, events)
      eventCount += events.length
    }
  }

  return { runCount: RUN_SPECS.length, eventCount }
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString()
}
