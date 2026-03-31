import type { RepoConfig } from '../config/schema.js'
import type { LabelConfig } from './transitions.js'

export function buildLabelConfig(repoConfig: Pick<RepoConfig, 'labels'>): LabelConfig {
  return {
    ready: repoConfig.labels.ready,
    running: repoConfig.labels.running,
    blocked: repoConfig.labels.blocked,
    needsHuman: repoConfig.labels.needsHuman,
    reviewReady: repoConfig.labels.reviewReady,
    error: repoConfig.labels.error,
    retry: repoConfig.labels.retry,
    mergeQueued: repoConfig.labels.mergeQueued,
    merging: repoConfig.labels.merging,
    mergeFailed: repoConfig.labels.mergeFailed,
  }
}
