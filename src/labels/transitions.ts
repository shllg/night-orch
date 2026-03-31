import type { RunStatus } from '../state/runs.js'
import type { BlockReason } from '../loop/types.js'
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
  mergeQueued: string
  merging: string
  mergeFailed: string
}

/** Returns true if the block reason genuinely requires human intervention. */
export function isHumanRequired(reason: BlockReason): boolean {
  return reason === 'reviewer_blocked'
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
  blockReason?: BlockReason,
): LabelMutation {
  const current = new Set(currentLabels)
  let add: string[] = []
  let remove: string[] = []

  switch (to) {
    case 'running':
      add = [config.running]
      remove = [...config.ready, config.blocked, config.needsHuman, config.error, config.retry]
      break
    case 'blocked':
      if (blockReason && isHumanRequired(blockReason)) {
        add = [config.blocked, config.needsHuman]
      } else {
        add = [config.blocked]
      }
      remove = [config.running]
      break
    case 'review_ready':
      add = [config.reviewReady]
      remove = [config.running, config.retry]
      break
    case 'error':
      add = [config.error]
      remove = [config.running]
      break
    case 'completed':
      remove = [config.running, config.reviewReady]
      break
    case 'queued':
      add = [...config.ready]
      remove = [config.running, config.blocked, config.needsHuman, config.error, config.reviewReady, config.retry]
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
