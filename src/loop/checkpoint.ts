import type Database from 'better-sqlite3'
import type { LoopPhase, RunContext, PlannerOutput, CoderOutput, ReviewerOutput, VerifyResult } from './types.js'
import type { WorkflowStep } from './workflow.js'
import { RunManager } from '../state/runs.js'
import { insertRunLogEvent } from '../state/run-log-events.js'
import { nowUtcIso } from '../utils/time.js'
import { logger } from '../utils/logger.js'
import {
  extractCompletedPhases,
  extractDecisionOutcomes,
  parsePhaseData,
  SENTINEL_KEYS,
  type PersistedDecisionOutcome,
} from './checkpoint-schema.js'
import { recordPhase, updateContext } from './context.js'
import { LEGACY_BLOCK_REASON_VALUES } from './state.js'

export interface CheckpointArtifactEvent {
  runId: string
  phase: string
  eventType: string
  data: Record<string, unknown> | null
  timestamp: string
}

export interface CheckpointArtifactEventWriter {
  recordPhaseEvent(event: CheckpointArtifactEvent): void
}

/**
 * Sentinel key used to store an array of completed phase IDs in phase_data.
 * Used on resume to determine whether a phase was merely entered (started)
 * or fully completed — a distinction that matters for decide steps whose
 * terminal outcome must not be re-routed to iterate on resume.
 */
const COMPLETED_PHASES_KEY = SENTINEL_KEYS.completedPhases

/**
 * Sentinel key for session IDs. Persisted across crashes so
 * multi-step workflows can resume their `--continue` chains on the worker.
 */
const SESSION_IDS_KEY = SENTINEL_KEYS.sessionIds

/**
 * Sentinel key for generic custom-role step outputs. buildStepArtifacts
 * only persists well-known role outputs (plan/code/review/verify); without
 * this escape hatch custom-workflow step outputs are lost on resume.
 */
const STEP_OUTPUTS_KEY = SENTINEL_KEYS.stepOutputs

/**
 * Sentinel key for terminal outcomes of decide steps. When present, the
 * engine must not re-enter the loop on resume — it routes straight to the
 * terminal state instead.
 */
const DECISION_OUTCOMES_KEY = SENTINEL_KEYS.decisionOutcomes

export { extractCompletedPhases, extractDecisionOutcomes }
export type { PersistedDecisionOutcome }

/**
 * Given a map of persisted decision outcomes, return the first terminal
 * one (`publish` / `block` / `error`). `iterate` is deliberately excluded —
 * it is not terminal, the crashed attempt went on to re-run earlier steps.
 *
 * Returns `null` when no decision has reached a terminal action yet.
 */
export function findTerminalDecisionOutcome(
  outcomes: Record<string, PersistedDecisionOutcome>,
): { phase: string; outcome: PersistedDecisionOutcome } | null {
  for (const [phase, outcome] of Object.entries(outcomes)) {
    if (outcome.action === 'publish' || outcome.action === 'block' || outcome.action === 'error') {
      return { phase, outcome }
    }
  }
  return null
}

export function resolveStartingStepIndex(
  steps: WorkflowStep[],
  resumedCtx: RunContext | null,
  checkpointPhaseData: Readonly<Record<string, unknown>>,
  completedPhases: readonly string[],
): number {
  if (!resumedCtx) return 0

  const resumedPhaseIndex = steps.findIndex((step) => step.id === resumedCtx.currentPhase)
  if (resumedPhaseIndex === -1) return 0

  const resumedStep = steps[resumedPhaseIndex]!
  const hasCompletedSentinel = completedPhases.length > 0
  const artifactComplete = isStepCheckpointComplete(resumedStep, checkpointPhaseData[resumedStep.id])
  const isCompletedCheckpoint = hasCompletedSentinel
    ? completedPhases.includes(resumedStep.id) && artifactComplete
    : artifactComplete
  if (!isCompletedCheckpoint) {
    return resumedPhaseIndex
  }

  if (resumedStep.type === 'decide') {
    const iterateTargetIndex = steps.findIndex((step) => step.id === resumedStep.onIterate)
    return iterateTargetIndex >= 0 ? iterateTargetIndex : 0
  }

  const nextStepIndex = resumedPhaseIndex + 1
  return nextStepIndex < steps.length ? nextStepIndex : resumedPhaseIndex
}

export function applyPersistedDecisionOutcome(
  ctx: RunContext,
  terminal: { phase: string; outcome: PersistedDecisionOutcome },
): RunContext {
  const { phase, outcome } = terminal
  switch (outcome.action) {
    case 'publish':
      return recordPhase(
        updateContext(ctx, { currentPhase: 'completed', terminalStatus: 'publish' }),
        phase,
        'success',
      )
    case 'block':
      return recordPhase(
        updateContext(ctx, {
          currentPhase: 'blocked',
          terminalStatus: 'blocked',
          blockReason: coercePersistedBlockReason(outcome.blockReason),
          stepOutputs: {
            ...ctx.stepOutputs,
            blockMessage: outcome.reason ?? 'Blocked by prior decide outcome',
          },
        }),
        phase,
        'failure',
      )
    case 'error':
      return recordPhase(
        updateContext(ctx, { currentPhase: 'error', terminalStatus: 'error' }),
        phase,
        'failure',
      )
    default:
      return ctx
  }
}

const LEGACY_BLOCK_REASONS = new Set<NonNullable<RunContext['blockReason']>>(LEGACY_BLOCK_REASON_VALUES)

function coercePersistedBlockReason(
  value: unknown,
): RunContext['blockReason'] {
  if (typeof value !== 'string') {
    return null
  }
  return LEGACY_BLOCK_REASONS.has(value as NonNullable<RunContext['blockReason']>)
    ? (value as NonNullable<RunContext['blockReason']>)
    : null
}

function isStepCheckpointComplete(step: WorkflowStep, rawArtifacts: unknown): boolean {
  if (typeof rawArtifacts !== 'object' || rawArtifacts === null || Array.isArray(rawArtifacts)) {
    return false
  }

  const artifacts = rawArtifacts as Record<string, unknown>
  switch (step.type) {
    case 'worker':
      if (step.role === 'planner') return artifacts['plan'] !== null && artifacts['plan'] !== undefined
      if (step.role === 'coder') return artifacts['codeResult'] !== null && artifacts['codeResult'] !== undefined
      if (step.role === 'reviewer') return artifacts['reviewResult'] !== null && artifacts['reviewResult'] !== undefined
      return 'stepOutput' in artifacts
    case 'verify':
      return Array.isArray(artifacts['verifyResults'])
    case 'decide':
      return true
  }
}

export function clearResumeDecisionArtifacts(
  phaseData: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!phaseData) return {}

  const next = { ...phaseData }
  delete next[DECISION_OUTCOMES_KEY]

  const stepOutputs = next[STEP_OUTPUTS_KEY]
  if (isRecord(stepOutputs) && 'blockMessage' in stepOutputs) {
    const nextStepOutputs = { ...stepOutputs }
    delete nextStepOutputs['blockMessage']
    next[STEP_OUTPUTS_KEY] = nextStepOutputs
  }

  return next
}

export class Checkpoint {
  private runManager: RunManager

  constructor(
    private db: Database.Database,
    private artifactWriter?: CheckpointArtifactEventWriter,
  ) {
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

    const phaseData = this.parsePhaseDataWithQuarantine(runId, row.current_phase, row.phase_data)
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
    return extractCompletedPhases(phaseData)
  }

  /**
   * Return terminal decision outcomes for decide steps that ran and
   * finished (possibly mid-decide-action) prior to a crash.
   */
  getDecisionOutcomes(runId: string): Record<string, PersistedDecisionOutcome> {
    const phaseData = this.getPhaseData(runId)
    return extractDecisionOutcomes(phaseData)
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

    const phaseData = this.parsePhaseDataWithQuarantine(runId, row.current_phase, row.phase_data)

    // Reconstruct context from persisted phase artifacts
    const planArtifacts = phaseData['plan'] as Record<string, unknown> | undefined
    const codeArtifacts = phaseData['code'] as Record<string, unknown> | undefined
    const reviewArtifacts = phaseData['review'] as Record<string, unknown> | undefined
    const verifyArtifacts = phaseData['verify'] as Record<string, unknown> | undefined
    const persistedSessionIds = phaseData[SESSION_IDS_KEY]
    const persistedStepOutputs = phaseData[STEP_OUTPUTS_KEY]

    // Rehydrate diff/diffError/emptyDiffRetries from verify artifacts for crash recovery
    const verifyDiff = typeof verifyArtifacts?.diff === 'string' ? verifyArtifacts.diff : baseCtx.diff
    const verifyDiffError = typeof verifyArtifacts?.diffError === 'string' ? verifyArtifacts.diffError : null
    const verifyEmptyDiffRetries = typeof verifyArtifacts?.emptyDiffRetries === 'number'
      ? verifyArtifacts.emptyDiffRetries
      : baseCtx.emptyDiffRetries

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
      diff: verifyDiff,
      diffError: verifyDiffError,
      emptyDiffRetries: verifyEmptyDiffRetries,
    }
  }

  getPhaseData(runId: string): Record<string, unknown> {
    const row = this.db
      .prepare('SELECT current_phase, phase_data FROM runs WHERE id = ?')
      .get(runId) as { current_phase: string | null; phase_data: string | null } | undefined

    if (!row?.phase_data) return {}
    return this.parsePhaseDataWithQuarantine(runId, row.current_phase, row.phase_data)
  }

  /**
   * Parse a raw `phase_data` blob through the R5 zod schema. On
   * failure (JSON parse error, non-object top level, or sentinel-key
   * shape mismatch), write a row to `checkpoint_quarantine` so the
   * operator can inspect the corruption later, and return an empty
   * object so the caller resumes as if no checkpoint existed.
   *
   * This is the only path that reads phase_data across the
   * Checkpoint class — pre-R5 the equivalent `safeParsePhaseData`
   * function silently returned `{}` with a warning log, which meant
   * corruption was invisible to anyone not tailing the logs.
   */
  private parsePhaseDataWithQuarantine(
    runId: string,
    phase: string | null,
    raw: string | null | undefined,
  ): Record<string, unknown> {
    const result = parsePhaseData(raw)
    if (result.ok) return result.data

    logger.warn(
      {
        runId,
        phase,
        reason: result.reason,
        detail: result.detail,
        payloadLength: raw?.length ?? 0,
      },
      'phase_data failed validation — quarantining row and resuming as empty',
    )

    try {
      this.db
        .prepare(
          `INSERT INTO checkpoint_quarantine
             (run_id, phase, reason, detail, payload)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, phase, result.reason, result.detail, result.payload)
    } catch (err) {
      // Never let a quarantine write failure take down the read.
      logger.error(
        { runId, phase, err },
        'Failed to write checkpoint_quarantine row — phase_data corruption may be lost',
      )
    }

    return {}
  }

  private recordEvent(
    runId: string,
    eventType: string,
    phase: LoopPhase,
    data: Record<string, unknown> | null,
  ): void {
    const now = nowUtcIso()
    const artifactEvent: CheckpointArtifactEvent = {
      runId,
      phase,
      eventType,
      data,
      timestamp: now,
    }
    try {
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
      insertRunLogEvent(this.db, {
        runId,
        source: 'system',
        phase,
        role: null,
        type: eventType,
        data,
        timestamp: now,
      })
    } catch (err) {
      // Best-effort event recording: checkpoint persistence must still succeed.
      // Log at debug so operators can diagnose silent drops without spamming.
      logger.debug({ runId, eventType, phase, err }, 'Failed to record phase event')
    }

    if (this.artifactWriter) {
      try {
        this.artifactWriter.recordPhaseEvent(artifactEvent)
      } catch (err) {
        logger.debug(
          { runId, eventType, phase, err },
          'Failed to record durable artifact event',
        )
      }
    }
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
