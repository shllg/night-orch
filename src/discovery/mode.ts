import type { RepoConfig } from '../config/schema.js'

export type ExecutionMode = 'implementation' | 'planning'

/**
 * Resolve execution mode from issue labels.
 * Planning mode is opt-in via a dedicated label.
 */
export function resolveExecutionMode(
  issueLabels: string[],
  repoConfig: Partial<Pick<RepoConfig, 'planning'>>,
): ExecutionMode {
  const planningLabel = repoConfig.planning?.label ?? 'orch:planning'
  return issueLabels.includes(planningLabel) ? 'planning' : 'implementation'
}
