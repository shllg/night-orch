import type { UpdateStrategy } from '../git/worktree.js'

export interface FullConflictSource {
  path: string
  mergedWithMarkers: string
  base: string
  ours: string
  theirs: string
}

export interface ConflictResolutionContext {
  issueTitle: string
  issueBody: string
}

export interface ResolvedConflictFile {
  path: string
  resolved: string
}

export type ConflictResolutionOutcome =
  | 'resolved'
  | 'unresolved'
  | 'validation_failed'
  | 'error'

export interface ConflictResolutionMetadata {
  attempted: boolean
  outcome: ConflictResolutionOutcome
  files?: string[]
}

export type ConflictSnapshotSource = 'branch_refresh' | 'manual_rebase' | 'publish_push'
export type ConflictSnapshotKind = 'merge' | 'rebase' | 'unknown'

export interface ConflictSnapshotExcerpt {
  path: string
  preview: string
  base?: string
  ours?: string
  theirs?: string
}

export interface ConflictSnapshot {
  schemaVersion: 1
  capturedAt: string
  source: ConflictSnapshotSource
  kind: ConflictSnapshotKind
  strategy: UpdateStrategy
  summary: string
  branchName: string
  baseBranch: string
  branchHeadSha: string | null
  baseHeadSha: string | null
  files: string[]
  excerpts: ConflictSnapshotExcerpt[]
  resolution?: ConflictResolutionMetadata
}

export type ConflictResolutionFailureOutcome = Exclude<ConflictResolutionOutcome, 'resolved'>

export type ConflictResolverResult =
  | {
      ok: true
      files: ResolvedConflictFile[]
    }
  | {
      ok: false
      outcome: ConflictResolutionFailureOutcome
      reason: string
      files?: string[]
    }

export interface ConflictResolverInvocation {
  repo: string
  issueNumber: number
  attempt: number
}

export interface ConflictResolver {
  readonly maxAttempts: number
  readonly maxFiles: number
  resolveConflicts(
    sources: FullConflictSource[],
    context: ConflictResolutionContext,
    invocation: ConflictResolverInvocation,
  ): Promise<ConflictResolverResult>
}

export function isConflictSnapshot(value: unknown): value is ConflictSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate['schemaVersion'] === 1
    && typeof candidate['capturedAt'] === 'string'
    && typeof candidate['source'] === 'string'
    && typeof candidate['kind'] === 'string'
    && typeof candidate['strategy'] === 'string'
    && typeof candidate['summary'] === 'string'
    && typeof candidate['branchName'] === 'string'
    && typeof candidate['baseBranch'] === 'string'
    && Array.isArray(candidate['files'])
    && Array.isArray(candidate['excerpts'])
}

export function coerceConflictSnapshot(value: unknown): ConflictSnapshot | null {
  return isConflictSnapshot(value) ? value : null
}
