import type Database from 'better-sqlite3'
import type { LoopPhase, RunContext, PlannerOutput, CoderOutput, ReviewerOutput } from './types.js'

export class Checkpoint {
  constructor(private db: Database.Database) {}

  phaseStarted(runId: string, phase: LoopPhase): void {
    this.db
      .prepare("UPDATE runs SET current_phase = ?, updated_at = datetime('now') WHERE id = ?")
      .run(phase, runId)
    this.recordEvent(runId, 'phase_started', phase, null)
  }

  phaseCompleted(runId: string, phase: LoopPhase, artifacts: Record<string, unknown>): void {
    // Merge artifacts with existing phase_data
    const existing = this.getPhaseData(runId)
    const merged = { ...existing, [phase]: artifacts }

    this.db
      .prepare(
        "UPDATE runs SET current_phase = ?, phase_data = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(phase, JSON.stringify(merged), runId)
    this.recordEvent(runId, 'phase_completed', phase, artifacts)
  }

  getLastCompleted(runId: string): { phase: LoopPhase; artifacts: Record<string, unknown> } | null {
    const row = this.db
      .prepare('SELECT current_phase, phase_data FROM runs WHERE id = ?')
      .get(runId) as { current_phase: string | null; phase_data: string | null } | undefined

    if (!row?.current_phase) return null

    const phaseData = row.phase_data ? JSON.parse(row.phase_data) as Record<string, unknown> : {}
    const phaseArtifacts = (phaseData[row.current_phase] as Record<string, unknown>) ?? {}

    return {
      phase: row.current_phase,
      artifacts: phaseArtifacts,
    }
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

    const phaseData = row.phase_data ? JSON.parse(row.phase_data) as Record<string, unknown> : {}

    // Reconstruct context from persisted phase artifacts
    const planArtifacts = phaseData['plan'] as Record<string, unknown> | undefined
    const codeArtifacts = phaseData['code'] as Record<string, unknown> | undefined
    const reviewArtifacts = phaseData['review'] as Record<string, unknown> | undefined

    return {
      ...baseCtx,
      currentPhase: row.current_phase,
      terminalStatus: 'running',
      iteration: row.iteration_count ?? baseCtx.iteration,
      estimatedCostUsd: row.estimated_cost_usd ?? baseCtx.estimatedCostUsd,
      plan: (planArtifacts?.plan as PlannerOutput) ?? baseCtx.plan,
      codeResult: (codeArtifacts?.codeResult as CoderOutput) ?? baseCtx.codeResult,
      reviewResult: (reviewArtifacts?.reviewResult as ReviewerOutput) ?? baseCtx.reviewResult,
    }
  }

  private getPhaseData(runId: string): Record<string, unknown> {
    const row = this.db
      .prepare('SELECT phase_data FROM runs WHERE id = ?')
      .get(runId) as { phase_data: string | null } | undefined

    if (!row?.phase_data) return {}
    return JSON.parse(row.phase_data) as Record<string, unknown>
  }

  private recordEvent(
    runId: string,
    eventType: string,
    phase: LoopPhase,
    data: Record<string, unknown> | null,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO events (run_id, repo, issue_number, event_type, phase, data, created_at)
           SELECT ?, repo, issue_number, ?, ?, ?, datetime('now')
           FROM runs
           WHERE id = ?`,
        )
        .run(
          runId,
          eventType,
          phase,
          data ? JSON.stringify(data) : null,
          runId,
        )
    } catch {
      // Best-effort event recording: checkpoint persistence must still succeed.
    }
  }
}
