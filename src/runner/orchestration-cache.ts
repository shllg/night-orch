import type { ReactionCursor } from '../reactions/types.js'

export interface OrchestrationCache {
  missingCommentCommandIssues: Set<string>
  reactionCursors: Map<string, ReactionCursor>
}

export function createOrchestrationCache(): OrchestrationCache {
  return {
    missingCommentCommandIssues: new Set<string>(),
    reactionCursors: new Map<string, ReactionCursor>(),
  }
}
