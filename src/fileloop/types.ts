import type { VerifyResult, WorkerTaskResult } from '../workers/types.js'

export type FileLoopSessionStatus =
  | 'armed'
  | 'running'
  | 'paused'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled'

export type FileLoopStoppedReason =
  | 'timer'
  | 'manual'
  | 'budget'
  | 'error'
  | 'exhausted'
  | null

export type FileLoopFileStatus = 'edited' | 'noop' | 'deferred' | 'skipped' | 'error'
export type FileLoopDifficulty = 'trivial' | 'moderate' | 'complex'

export interface FileLoopSession {
  id: number
  repo: string
  branch: string
  worktreePath: string
  startedAt: string
  endsAt: string
  status: FileLoopSessionStatus
  lastFileIterAt: string | null
  iterations: number
  filesTouched: number
  totalCostUsd: number
  prNumber: number | null
  stoppedReason: FileLoopStoppedReason
  updatedAt: string
}

export interface FileLoopFileState {
  repo: string
  filePath: string
  lastTouchedAt: string | null
  lastStatus: FileLoopFileStatus | null
  lastSummaryShort: string | null
  lastDifficultyFlag: FileLoopDifficulty | null
  touchCount: number
}

export interface PickedCandidate {
  filePath: string
  lineCount: number
  lastTouchedAt: string | null
}

export interface FileReviewEdit {
  filePath: string
  search: string
  replace: string
}

export interface FileReviewOutput {
  trivialFixes: FileReviewEdit[]
  refactorNotes: string | null
  difficulty: FileLoopDifficulty
  summary: string
}

export interface FileLoopVerifyResult {
  results: VerifyResult[]
  passed: boolean
}

export type TickResult =
  | { kind: 'edited'; filePath: string; summary: string; costUsd: number; worker: WorkerTaskResult }
  | { kind: 'noop'; filePath: string; summary: string; costUsd: number; worker: WorkerTaskResult }
  | { kind: 'deferred'; filePath: string; summary: string; costUsd: number; worker: WorkerTaskResult; difficulty: FileLoopDifficulty }
  | { kind: 'error'; filePath: string | null; summary: string; costUsd: number; worker?: WorkerTaskResult | null }
  | { kind: 'exhausted'; summary: string }
