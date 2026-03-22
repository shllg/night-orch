import type { RepoConfig } from '../config/schema.js'
import type { LabelConfig } from './transitions.js'

export function buildLabelConfig(repoConfig: Pick<RepoConfig, 'labels'>): LabelConfig {
  return {
    ready: repoConfig.labels.ready,
    running: repoConfig.labels.running,
    blocked: repoConfig.labels.blocked,
    reviewReady: repoConfig.labels.reviewReady,
    error: repoConfig.labels.error,
    retry: repoConfig.labels.retry,
  }
}
