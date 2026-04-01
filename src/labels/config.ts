import type { RepoConfig } from '../config/schema.js'
import type { LabelConfig } from './transitions.js'

type LabelsSource = RepoConfig['labels']

export function isKanbanIssue(
  issueLabels: readonly string[] | undefined,
  repoConfig: Pick<RepoConfig, 'kanban'>,
): boolean {
  const trigger = repoConfig.kanban?.triggerLabel
  if (typeof trigger !== 'string' || trigger.length === 0) return false
  if (!issueLabels) return false
  return issueLabels.includes(trigger)
}

export function getDiscoveryIncludeLabels(
  repoConfig: Pick<RepoConfig, 'selectors' | 'kanban'>,
): string[] {
  const include = new Set<string>(repoConfig.selectors?.includeLabelsAny ?? [])
  if (repoConfig.kanban) {
    for (const label of asLabelArray(repoConfig.kanban.labels.ready, [])) {
      include.add(label)
    }
  }
  return [...include]
}

export function buildLabelConfig(
  repoConfig: Pick<RepoConfig, 'labels' | 'kanban'>,
  issueLabels?: readonly string[],
): LabelConfig {
  const source: LabelsSource = isKanbanIssue(issueLabels, repoConfig) && repoConfig.kanban
    ? repoConfig.kanban.labels
    : repoConfig.labels

  return {
    ready: asLabelArray(source.ready, ['orch:ready']),
    running: asSingleLabel(source.running, 'orch:running'),
    blocked: asSingleLabel(source.blocked, 'orch:blocked'),
    needsHuman: asSingleLabel(source.needsHuman, 'orch:needs-human'),
    reviewReady: asSingleLabel(source.reviewReady, 'orch:review-ready'),
    error: asSingleLabel(source.error, 'orch:error'),
    retry: asSingleLabel(source.retry, 'orch:retry'),
    planning: asSingleLabel(source.planning, 'orch:planning'),
    mergeQueued: asSingleLabel(source.mergeQueued, 'orch:merge-queued'),
    merging: asSingleLabel(source.merging, 'orch:merging'),
    mergeFailed: asSingleLabel(source.mergeFailed, 'orch:merge-failed'),
  }
}

function asSingleLabel(value: string | readonly string[] | undefined, fallback: string): string {
  if (typeof value === 'string') {
    return value.length > 0 ? value : fallback
  }
  if (Array.isArray(value)) {
    const first = value.find((label): label is string => typeof label === 'string' && label.length > 0)
    return first ?? fallback
  }
  return fallback
}

function asLabelArray(value: string | readonly string[] | undefined, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const labels = value.filter((label): label is string => typeof label === 'string' && label.length > 0)
    return labels.length > 0 ? labels : fallback
  }
  if (typeof value === 'string' && value.length > 0) {
    return [value]
  }
  return [...fallback]
}
