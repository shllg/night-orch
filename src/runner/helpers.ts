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
  TAINTED_BLOCK_REASONS,
  shouldResetBranch,
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
