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
