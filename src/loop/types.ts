import type { ForgeIssue } from '../forge/types.js'
import type { RepoConfig } from '../config/schema.js'
import type { ResolvedRoles } from '../discovery/roles.js'
import type { TriageResult, TriageAdjustedLimits } from '../discovery/triage.js'
import type { PlannerOutput, CoderOutput, ReviewerOutput, ReviewFinding, VerifyResult } from '../workers/types.js'

export type BlockReason =
  | 'cost_limit'
  | 'iteration_limit'
  | 'agent_pass_limit'
  | 'reviewer_blocked'
  | 'ambiguous_review'
  | 'verify_config'

export type RunMode = 'fresh' | 'followup'

export type LoopPhase =
  | 'plan'
  | 'code'
  | 'verify'
  | 'review'
  | 'decision'
  | 'publish'
  | 'notify'
  | 'completed'
  | 'blocked'
  | 'error'

export interface PhaseRecord {
  phase: LoopPhase
  startedAt: string
  completedAt: string
  result: 'success' | 'failure' | 'skipped'
  artifacts: Record<string, unknown>
}

export interface RunContext {
  readonly runId: string
  readonly repo: string
  readonly issueNumber: number
  readonly issue: ForgeIssue
  readonly repoConfig: RepoConfig
  readonly roles: ResolvedRoles
  readonly triageResult: TriageResult
  readonly adjustedLimits: TriageAdjustedLimits
  readonly branchName: string
  readonly worktreePath: string

  readonly plan: PlannerOutput | null
  readonly codeResult: CoderOutput | null
  readonly diff: string | null
  readonly verifyResults: VerifyResult[]
  readonly reviewResult: ReviewerOutput | null
  readonly reviewFindings: ReviewFinding[]

  readonly iteration: number
  readonly totalAgentPasses: number
  readonly estimatedCostUsd: number

  readonly currentPhase: LoopPhase
  readonly terminalStatus: TerminalStatus
  readonly phaseHistory: PhaseRecord[]

  readonly dryRun: boolean

  readonly runMode: RunMode
  readonly blockReason: BlockReason | null
  readonly prReviewFeedback: unknown | null

  /** Session IDs from worker adapters, keyed by role, for conversation continuity. */
  readonly sessionIds: Readonly<Record<string, string>>
}

export type LoopDecision =
  | { action: 'publish'; reason: string }
  | { action: 'iterate'; reason: string; findings: ReviewFinding[] }
  | { action: 'block'; reason: string; blockReason: BlockReason }
  | { action: 'error'; reason: string }

export type TerminalStatus = 'running' | 'publish' | 'blocked' | 'error'

export type { PlannerOutput, CoderOutput, ReviewerOutput, ReviewFinding, VerifyResult }
