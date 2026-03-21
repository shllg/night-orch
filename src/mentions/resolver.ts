import type { RepoConfig } from '../config/schema.js'

interface AppMentionConfig {
  enabled: boolean
  commentTemplate: string
}

/**
 * Resolve which mention keys should be posted on a PR.
 * Pure function — no side effects.
 */
export function resolveMentions(
  issueLabels: string[],
  repoDefaults: RepoConfig['defaults'],
  appMentions: Record<string, AppMentionConfig>,
): string[] {
  const result = new Set<string>()

  // 1. Check issue labels for pr-mention:xxx
  for (const label of issueLabels) {
    if (label.startsWith('pr-mention:')) {
      result.add(label.slice('pr-mention:'.length))
    }
  }

  // 2. Add repo defaults
  for (const mention of repoDefaults.prMentions) {
    result.add(mention)
  }

  // 3. Filter out disabled app mentions
  for (const key of result) {
    const config = appMentions[key]
    if (config && !config.enabled) {
      result.delete(key)
    }
  }

  return [...result]
}
