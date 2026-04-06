import type Database from 'better-sqlite3'
import type { LoopPhase, RunContext, PlannerOutput, CoderOutput, ReviewerOutput, VerifyResult } from './types.js'
import { RunManager } from '../state/runs.js'
import { nowUtcIso } from '../utils/time.js'
import { logger } from '../utils/logger.js'

/**
 * Sentinel key used to store an array of completed phase IDs in phase_data.
 * Used on resume to determine whether a phase was merely entered (started)
 * or fully completed — a distinction that matters for decide steps whose
 * terminal outcome must not be re-routed to iterate on resume.
 */
const COMPLETED_PHASES_KEY = '__completedPhases'

/**
 * Sentinel key for session IDs. Persisted across crashes so
 * multi-step workflows can resume their `--continue` chains on the worker.
 */
const SESSION_IDS_KEY = '__sessionIds'

/**
 * Sentinel key for generic custom-role step outputs. buildStepArtifacts
 * only persists well-known role outputs (plan/code/review/verify); without
 * this escape hatch custom-workflow step outputs are lost on resume.
 */
const STEP_OUTPUTS_KEY = '__stepOutputs'

/**
 * Sentinel key for terminal outcomes of decide steps. When present, the
 * engine must not re-enter the loop on resume — it routes straight to the
 * terminal state instead.
 */
const DECISION_OUTCOMES_KEY = '__decisionOutcomes'

export interface PersistedDecisionOutcome {
  action: 'publish' | 'iterate' | 'block' | 'error'
  reason?: string
  blockReason?: string | null
}

export class Checkpoint {
  private runManager: RunManager

  constructor(private db: Database.Database) {
    this.runManager = new RunManager(db)
  }

  phaseStarted(runId: string, phase: LoopPhase, iteration?: number): void {
    this.runManager.updatePhaseCheckpoint(runId, phase, null, iteration)
    this.recordEvent(runId, 'phase_started', phase, null)
  }

  phaseCompleted(runId: string, phase: LoopPhase, artifacts: Record<string, unknown>, iteration?: number): void {
    // Merge artifacts with existing phase_data in a single DB transaction
    // so concurrent writers (e.g. parallel sub-tasks on the same run)
    // cannot lose updates. Also track the set of completed phases in
    // the same blob so resume can distinguish "entered" from "completed".
    const tx = this.db.transaction(() => {
      const existing = this.getPhaseData(runId)
      const prevCompleted = Array.isArray(existing[COMPLETED_PHASES_KEY])
        ? (existing[COMPLETED_PHASES_KEY] as string[])
        : []
      const completed = prevCompleted.includes(phase) ? prevCompleted : [...prevCompleted, phase]
      const merged = { ...existing, [phase]: artifacts, [COMPLETED_PHASES_KEY]: completed }

      this.runManager.updatePhaseCheckpoint(runId, phase, JSON.stringify(merged), iteration)
    })
    tx()
    this.recordEvent(runId, 'phase_completed', phase, artifacts)
  }

  /**
   * Record that a phase was skipped by the skipWhen guard. Emits matching
   * `phase_started` + `phase_completed` events with a `skipped=true` flag
   * so the event stream stays well-formed even though no work ran.
   */
  phaseSkipped(runId: string, phase: LoopPhase, iteration?: number): void {
    this.phaseStarted(runId, phase, iteration)
    this.phaseCompleted(runId, phase, { skipped: true }, iteration)
  }

  /**
   * Record that a phase was blocked (e.g. by cost cap). Pairs
   * phase_started/phase_completed with a `blocked` payload so the event
   * stream remains consistent and the downstream observability layer can
   * distinguish blocks from plain completions.
   */
  phaseBlocked(
    runId: string,
    phase: LoopPhase,
    reason: string,
    iteration?: number,
  ): void {
    this.phaseStarted(runId, phase, iteration)
    this.phaseCompleted(runId, phase, { blocked: true, reason }, iteration)
  }

  /**
   * Persist the terminal outcome of a decide step. Read by
   * `resumeFromCheckpoint` to short-circuit resume when a decide step
   * produced a terminal decision in the crashed attempt.
   */
  recordDecisionOutcome(runId: string, phase: LoopPhase, outcome: PersistedDecisionOutcome): void {
    const existing = this.getPhaseData(runId)
    const prev = (existing[DECISION_OUTCOMES_KEY] as Record<string, PersistedDecisionOutcome> | undefined) ?? {}
    const merged = {
      ...existing,
      [DECISION_OUTCOMES_KEY]: { ...prev, [phase]: outcome },
    }
    this.runManager.updatePhaseData(runId, JSON.stringify(merged))
  }

  /**
   * Persist the current sessionIds and stepOutputs maps so they survive
   * a daemon crash. Called by the engine after every worker step because
   * workers mutate these maps through `updateContext`.
   */
  persistRunState(
    runId: string,
    sessionIds: Readonly<Record<string, string>>,
    stepOutputs: Readonly<Record<string, unknown>>,
  ): void {
    const existing = this.getPhaseData(runId)
    const merged = {
      ...existing,
      [SESSION_IDS_KEY]: { ...sessionIds },
      [STEP_OUTPUTS_KEY]: { ...stepOutputs },
    }
    this.runManager.updatePhaseData(runId, JSON.stringify(merged))
  }

  getLastCompleted(runId: string): { phase: LoopPhase; artifacts: Record<string, unknown> } | null {
    const row = this.db
      .prepare('SELECT current_phase, phase_data FROM runs WHERE id = ?')
      .get(runId) as { current_phase: string | null; phase_data: string | null } | undefined

    if (!row?.current_phase) return null

    const phaseData = safeParsePhaseData(row.phase_data)
    const phaseArtifacts = (phaseData[row.current_phase] as Record<string, unknown>) ?? {}

    return {
      phase: row.current_phase,
      artifacts: phaseArtifacts,
    }
  }

  /**
   * Return the set of phase IDs that have a phase_completed checkpoint.
   */
  getCompletedPhases(runId: string): string[] {
    const phaseData = this.getPhaseData(runId)
    const raw = phaseData[COMPLETED_PHASES_KEY]
    return Array.isArray(raw) ? (raw as string[]) : []
  }

  /**
   * Return terminal decision outcomes for decide steps that ran and
   * finished (possibly mid-decide-action) prior to a crash.
   */
  getDecisionOutcomes(runId: string): Record<string, PersistedDecisionOutcome> {
    const phaseData = this.getPhaseData(runId)
    const raw = phaseData[DECISION_OUTCOMES_KEY]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw as Record<string, PersistedDecisionOutcome>
  }

  /**
   * Reconstruct a partial RunContext from checkpoint data for crash recovery.
   * Returns null if no checkpoint data exists for this run.
   */
  resumeFromCheckpoint(
    runId: string,
    baseCtx: RunContext,
  ): RunContext | null {
    const row = this.db
      .prepare('SELECT current_phase, phase_data, iteration_count, estimated_cost_usd FROM runs WHERE id = ?')
      .get(runId) as {
        current_phase: string | null
        phase_data: string | null
        iteration_count: number | null
        estimated_cost_usd: number | null
      } | undefined

    if (!row?.current_phase) return null

    const phaseData = safeParsePhaseData(row.phase_data)

    // Reconstruct context from persisted phase artifacts
    const planArtifacts = phaseData['plan'] as Record<string, unknown> | undefined
    const codeArtifacts = phaseData['code'] as Record<string, unknown> | undefined
    const reviewArtifacts = phaseData['review'] as Record<string, unknown> | undefined
    const verifyArtifacts = phaseData['verify'] as Record<string, unknown> | undefined
    const persistedSessionIds = phaseData[SESSION_IDS_KEY]
    const persistedStepOutputs = phaseData[STEP_OUTPUTS_KEY]

    return {
      ...baseCtx,
      currentPhase: row.current_phase,
      terminalStatus: 'running',
      iteration: row.iteration_count ?? baseCtx.iteration,
      estimatedCostUsd: row.estimated_cost_usd ?? baseCtx.estimatedCostUsd,
      plan: (planArtifacts?.plan as PlannerOutput) ?? baseCtx.plan,
      codeResult: (codeArtifacts?.codeResult as CoderOutput) ?? baseCtx.codeResult,
      verifyResults: Array.isArray(verifyArtifacts?.verifyResults)
        ? verifyArtifacts.verifyResults as VerifyResult[]
        : baseCtx.verifyResults,
      reviewResult: (reviewArtifacts?.reviewResult as ReviewerOutput) ?? baseCtx.reviewResult,
      sessionIds: isStringRecord(persistedSessionIds) ? persistedSessionIds : baseCtx.sessionIds,
      stepOutputs: isRecord(persistedStepOutputs) ? persistedStepOutputs : baseCtx.stepOutputs,
    }
  }

  private getPhaseData(runId: string): Record<string, unknown> {
    const row = this.db
      .prepare('SELECT phase_data FROM runs WHERE id = ?')
      .get(runId) as { phase_data: string | null } | undefined

    if (!row?.phase_data) return {}
    return safeParsePhaseData(row.phase_data)
  }

  private recordEvent(
    runId: string,
    eventType: string,
    phase: LoopPhase,
    data: Record<string, unknown> | null,
  ): void {
    try {
      const now = nowUtcIso()
      this.db
        .prepare(
          `INSERT INTO events (run_id, repo, issue_number, event_type, phase, data, created_at)
           SELECT ?, repo, issue_number, ?, ?, ?, ?
           FROM runs
           WHERE id = ?`,
        )
        .run(
          runId,
          eventType,
          phase,
          data ? JSON.stringify(data) : null,
          now,
          runId,
        )
    } catch (err) {
      // Best-effort event recording: checkpoint persistence must still succeed.
      // Log at debug so operators can diagnose silent drops without spamming.
      logger.debug({ runId, eventType, phase, err }, 'Failed to record phase event')
    }
  }
}

/**
 * Parse a phase_data JSON blob defensively. A corrupt row must not take
 * down checkpoint reads; the run will simply resume as if no checkpoint
 * existed. Logs a warning so operators can notice data corruption.
 */
function safeParsePhaseData(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    logger.warn({ err, phaseDataLength: raw.length }, 'Failed to parse phase_data JSON — treating as empty')
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false
  }
  return true
}
