export {
  STATUS_MARKER,
  buildBlockReason,
  blockReasonSummary,
  formatBlockComment,
  makePayload,
  postStatusComment,
  postErrorStatusComment,
  toErrorMessage,
  sanitizeErrorForComment,
  type PostStatusCommentParams,
  type PostErrorStatusCommentParams,
} from './comment-formatting.js'

export {
  isImmediateFollowupStatus,
  extractFollowupPromptFeedback,
  buildAttemptHistoryFollowup,
  resolveOperationIntent,
  resolveManualState,
  resolveControlPayload,
  selectReplayableRun,
  deriveBranchPolicy,
  type RunControlPayload,
  type FollowupPromptFeedback,
  type BranchPolicy,
  type DeriveBranchPolicyInput,
} from './intent.js'

export {
  coerceAgentName,
  applyWorkflowAgentOverrides,
  applyWorkflowRoleDefaults,
  resolveWorkerProfileForAgent,
} from './workflow-overlay.js'

export {
  TAINTED_BLOCK_REASONS,
  shouldResetBranch,
} from './queue.js'
