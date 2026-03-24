import type { ForgeAdapter } from '../forge/types.js'
import type { RunStatus } from '../state/runs.js'
import type { BlockReason } from '../loop/types.js'
import { computeLabelMutation, type LabelConfig } from './transitions.js'
import { logger } from '../utils/logger.js'

/**
 * Apply label mutations for a run status transition.
 * Best-effort: partial failures are logged but don't throw.
 */
export async function transitionLabels(
  forge: ForgeAdapter,
  repo: string,
  issueNumber: number,
  currentLabels: string[],
  from: RunStatus,
  to: RunStatus,
  labelConfig: LabelConfig,
  blockReason?: BlockReason,
): Promise<void> {
  const mutation = computeLabelMutation(from, to, currentLabels, labelConfig, blockReason)

  if (mutation.add.length === 0 && mutation.remove.length === 0) {
    return
  }

  logger.info(
    { repo, issueNumber, from, to, add: mutation.add, remove: mutation.remove },
    'Applying label transition',
  )

  if (mutation.add.length > 0) {
    try {
      await forge.addLabels(repo, issueNumber, mutation.add)
    } catch (err) {
      logger.warn({ repo, issueNumber, labels: mutation.add, err }, 'Failed to add labels')
    }
  }

  if (mutation.remove.length > 0) {
    try {
      await forge.removeLabels(repo, issueNumber, mutation.remove)
    } catch (err) {
      logger.warn({ repo, issueNumber, labels: mutation.remove, err }, 'Failed to remove labels')
    }
  }
}
