import type { RunStatus } from '../state/runs.js'

export interface LabelMutation {
  add: string[]
  remove: string[]
}

export interface LabelConfig {
  ready: string[]
  running: string
  blocked: string[]
  reviewReady: string
  error: string
  retry: string
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
): LabelMutation {
  const current = new Set(currentLabels)
  let add: string[] = []
  let remove: string[] = []

  switch (to) {
    case 'running':
      add = [config.running]
      remove = [...config.ready, ...config.blocked, config.error, config.retry]
      break
    case 'blocked':
      add = config.blocked
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
      remove = [config.running, ...config.blocked, config.error, config.reviewReady, config.retry]
      break
  }

  // Filter: don't add labels already present, don't remove labels not present
  add = add.filter((l) => !current.has(l))
  remove = remove.filter((l) => current.has(l))

  return { add, remove }
}
