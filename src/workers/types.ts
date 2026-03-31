import type { TriageLevel } from '../discovery/triage.js'
import type { AgentEvent } from '../events/types.js'

export type AgentRole = 'planner' | 'coder' | 'reviewer'
export type ReviewVerdict = 'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED'

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
  command: string
  args: string[]
  workerTimeoutSeconds: number
  minimalEnv: boolean
  runtimeWrapper: string | null
  env: Record<string, string>
}

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
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
  }
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
}

export interface WorkerAdapter {
  runTask(input: WorkerTaskInput): Promise<WorkerTaskResult>
  checkAvailability(): Promise<{ available: boolean; version: string | null }>
}
