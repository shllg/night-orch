import type { TriageLevel } from '../discovery/triage.js'
import type { AgentEvent } from '../events/types.js'

export type AgentRole = 'planner' | 'coder' | 'reviewer'
export type ReviewVerdict = 'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED'

/** Input for a single worker invocation. The adapter spawns the configured CLI tool with this. */
export interface WorkerTaskInput {
  runId?: string
  phase?: string
  role: AgentRole
  worktreePath: string
  prompt: string
  profile: WorkerProfileInput
  timeoutSeconds: number
  env: Record<string, string>
  onEvent?: (event: AgentEvent) => void
  /** Session ID from a prior phase to continue the conversation. */
  continueSessionId?: string | null
}

export interface WorkerProfileInput {
  type: string
  pricingModel?: string
  minuteUsd?: number
  command: string
  args: string[]
  workerTimeoutSeconds: number
  minimalEnv: boolean
  runtimeWrapper: string | null
  env: Record<string, string>
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
}

/** Raw + parsed output from a worker invocation, including cost signals and session continuity. */
export interface WorkerTaskResult {
  rawOutput: string
  exitCode: number
  timedOut: boolean
  durationMs: number
  parsed: PlannerOutput | CoderOutput | ReviewerOutput | null
  parseError: string | null
  /** Session/thread ID for continuing the conversation in subsequent phases. */
  sessionId: string | null
  /** Real token counts from the agent, when available. */
  tokenUsage?: TokenUsage
  /** Set by worker adapters when a non-zero exit is classified as an auth failure. */
  authFailure?: boolean
}

export interface PlannerOutput {
  objective: string
  assumptions: string[]
  filesToChange: string[]
  steps: PlanStep[]
  risks: string[]
  testStrategy: string
}

export interface PlanStep {
  order: number
  description: string
  files: string[]
}

export interface CoderOutput {
  summary: string
  changedFiles: string[]
  remainingUncertainty: string | null
  blockers: string[] | null
}

export interface ReviewerOutput {
  verdict: ReviewVerdict
  summary: string
  findings: ReviewFinding[]
  definitionOfDoneCheck: {
    issueAddressed: boolean
    testsPassing: boolean
    noBlockingFindings: boolean
  }
}

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor'
  message: string
  suggestedFix: string | null
}

export interface VerifyResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  passed: boolean
}

/** Data passed to prompt templates. Assembled by the prompt compiler from RunContext. */
export interface PromptContext {
  role: AgentRole
  issue: {
    number: number
    title: string
    body: string
    labels: string[]
  }
  repo: {
    name: string
    baseBranch: string
  }
  plan: string | null
  diff: string | null
  reviewFindings: ReviewFinding[] | null
  verifyResults: VerifyResult[] | null
  iteration: {
    current: number
    max: number
    isRetry: boolean
  }
  triageLevel: TriageLevel
  followup?: {
    type: string
    summary: string | null
    context: string
  } | null
}

/**
 * Abstraction over AI CLI tools (Claude, Codex, etc.).
 * Each adapter knows how to spawn its tool and parse availability info.
 */
export interface WorkerAdapter {
  runTask(input: WorkerTaskInput): Promise<WorkerTaskResult>
  checkAvailability(): Promise<{ available: boolean; version: string | null }>
}
