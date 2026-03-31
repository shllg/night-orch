import type { RepoConfig } from '../config/schema.js'

export interface LabelBootstrapDefinition {
  name: string
  color: string
  description: string
}

type LabelRole = 'ready' | 'running' | 'blocked' | 'reviewReady' | 'error' | 'retry' | 'planning' | 'mergeQueued' | 'merging' | 'mergeFailed'

const DEFAULT_LABEL_PRESENTATION: Record<LabelRole, { color: string; description: string }> = {
  ready: {
    color: '0E8A16',
    description: 'Queued for night-orch processing',
  },
  running: {
    color: 'FBCA04',
    description: 'Currently being processed by night-orch',
  },
  blocked: {
    color: 'D93F0B',
    description: 'Blocked and requires human intervention',
  },
  reviewReady: {
    color: '1D76DB',
    description: 'PR is ready for human review',
  },
  error: {
    color: 'B60205',
    description: 'Processing failed and needs investigation',
  },
  retry: {
    color: '5319E7',
    description: 'Queued for retry',
  },
  planning: {
    color: 'C2E0C6',
    description: 'Planning-only mode: produce a PRD markdown file (no code changes)',
  },
  mergeQueued: {
    color: '006B75',
    description: 'PR is queued in the merge queue',
  },
  merging: {
    color: '0075CA',
    description: 'PR is actively being merged via staging branch',
  },
  mergeFailed: {
    color: 'E4E669',
    description: 'Merge attempt failed; manual action required',
  },
}

/**
 * Build the labels that should exist for a repo, using role defaults and
 * optional per-label overrides from repo.labelConfig.
 */
export function buildLabelBootstrapDefinitions(
  repoConfig: Pick<RepoConfig, 'labels' | 'labelConfig'>,
): LabelBootstrapDefinition[] {
  const definitions: LabelBootstrapDefinition[] = []
  const seen = new Set<string>()

  const add = (name: string, role: LabelRole): void => {
    if (!name || seen.has(name)) return
    seen.add(name)

    const defaults = DEFAULT_LABEL_PRESENTATION[role]
    const override = repoConfig.labelConfig[name]

    definitions.push({
      name,
      color: (override?.color ?? defaults.color).toUpperCase(),
      description: override?.description ?? defaults.description,
    })
  }

  for (const label of repoConfig.labels.ready) add(label, 'ready')
  add(repoConfig.labels.running, 'running')
  for (const label of repoConfig.labels.blocked) add(label, 'blocked')
  add(repoConfig.labels.reviewReady, 'reviewReady')
  add(repoConfig.labels.error, 'error')
  add(repoConfig.labels.retry, 'retry')
  add(repoConfig.labels.planning, 'planning')
  add(repoConfig.labels.mergeQueued, 'mergeQueued')
  add(repoConfig.labels.merging, 'merging')
  add(repoConfig.labels.mergeFailed, 'mergeFailed')

  return definitions
}
