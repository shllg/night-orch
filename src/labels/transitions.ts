import type { RunStatus } from '../state/runs.js'
import type { RunOperationIntent } from '../state/runs.js'
import type { BlockedReason } from '../loop/state.js'
import type { MergeBatchStatus } from '../merge-queue/types.js'

export interface LabelMutation {
  add: string[]
  remove: string[]
}

export interface LabelConfig {
  ready: string[]
  running: string
  blocked: string
  needsHuman: string
  reviewReady: string
  error: string
  retry: string
  planning: string
  mergeQueued: string
  merging: string
  mergeFailed: string
  rebasing?: string
}

/**
 * Returns true if the block reason genuinely requires human intervention.
 *
 * Tracks `BlockedReason.recoverable === false` semantics from
 * `loop/state.ts:isBlockedReasonRecoverable`. The two functions answer
 * subtly different questions:
 *  - `isBlockedReasonRecoverable` → "will this clear naturally?"
 *  - `isHumanRequired` → "should we add the needsHuman label now?"
 *
 * Today only `reviewerBlocked` flips the label; merge-conflict and
 * auth-failure are non-recoverable but already convey their need via
 * the blocked label alone. R6 will revisit when ErrorRecovery moves
 * out of poller.
 */
export function isHumanRequired(reason: BlockedReason): boolean {
  return reason.type === 'reviewerBlocked'
}

/**
 * Compute label mutations for a run status transition.
 * Pure function — no side effects.
 */
export function computeLabelMutation(
  _from: RunStatus,
  to: RunStatus,
  currentLabels: string[],
  config: LabelConfig,
  blockReason?: BlockedReason,
  intent?: RunOperationIntent,
): LabelMutation {
  const current = new Set(currentLabels)
  let add: string[] = []
  let remove: string[] = []
  const transient = [config.running, config.rebasing].filter((label): label is string => Boolean(label))
  const queuedLabel = intent === 'rebase' && config.rebasing ? [config.rebasing] : [...config.ready]
  const runningLabel = intent === 'rebase' && config.rebasing ? config.rebasing : config.running

  switch (to) {
    case 'running':
      add = [runningLabel]
      remove = [...config.ready, ...transient, config.blocked, config.needsHuman, config.error, config.retry]
        .filter((label) => label !== runningLabel)
      break
    case 'blocked':
      if (blockReason && isHumanRequired(blockReason)) {
        add = [config.blocked, config.needsHuman]
        remove = [config.running]
      } else {
        add = [config.blocked]
        remove = [config.running, config.needsHuman]
      }
      break
    case 'review_ready':
      add = [config.reviewReady]
      remove = [
        ...config.ready,
        ...transient,
        config.blocked,
        config.needsHuman,
        config.error,
        config.retry,
      ]
      break
    case 'error':
      add = [config.error]
      remove = transient
      break
    case 'completed':
      remove = [...config.ready, ...transient, config.blocked, config.needsHuman, config.reviewReady, config.error, config.retry]
      break
    case 'queued':
      add = queuedLabel
      remove = [...config.ready, ...transient, config.blocked, config.needsHuman, config.error, config.reviewReady, config.retry]
        .filter((label) => !queuedLabel.includes(label))
      break
  }

  // Filter: don't add labels already present, don't remove labels not present
  add = add.filter((l) => !current.has(l))
  remove = remove.filter((l) => current.has(l))

  return { add, remove }
}

/**
 * Compute label mutations for a merge batch status transition.
 * Pure function — no side effects.
 */
export function computeMergeLabelMutation(
  to: MergeBatchStatus,
  currentLabels: string[],
  config: LabelConfig,
): LabelMutation {
  const current = new Set(currentLabels)
  let add: string[] = []
  let remove: string[] = []

  const allMergeLabels = [config.mergeQueued, config.merging, config.mergeFailed]

  switch (to) {
    case 'pending':
    case 'building':
    case 'testing':
      add = [config.mergeQueued]
      remove = [config.mergeFailed]
      break
    case 'bisecting':
      add = [config.merging]
      remove = [config.mergeQueued, config.mergeFailed]
      break
    case 'passed':
      remove = allMergeLabels
      break
    case 'failed':
      add = [config.mergeFailed]
      remove = [config.mergeQueued, config.merging]
      break
  }

  add = add.filter((l) => !current.has(l))
  remove = remove.filter((l) => current.has(l))

  return { add, remove }
}
