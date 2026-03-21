import type { WorkerProfileInput } from './types.js'
import { logger } from '../utils/logger.js'

export const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
] as const

export const ENV_BLACKLIST_EXACT = new Set([
  'GITHUB_TOKEN', 'GH_TOKEN', 'FORGEJO_TOKEN',
  'NIGHT_ORCH_WEBHOOK_URL',
])

export const ENV_BLACKLIST_PATTERNS = [
  /.*_SECRET$/,
  /.*_PASSWORD$/,
  /.*_KEY$/,
]

function isBlacklisted(key: string): boolean {
  if (ENV_BLACKLIST_EXACT.has(key)) return true
  return ENV_BLACKLIST_PATTERNS.some((p) => p.test(key))
}

/**
 * Build the env vars to pass to a worker process.
 * NEVER passes full process.env when minimalEnv is true.
 * NEVER passes GITHUB_TOKEN or any forge token regardless.
 */
export function buildWorkerEnv(profile: WorkerProfileInput): Record<string, string> {
  const result: Record<string, string> = {}

  if (profile.minimalEnv) {
    // Whitelist mode: only safe vars
    for (const key of ENV_WHITELIST) {
      const val = process.env[key]
      if (val !== undefined) result[key] = val
    }
  } else {
    // Pass everything minus blacklist (NOT recommended)
    for (const [key, val] of Object.entries(process.env)) {
      if (val !== undefined && !isBlacklisted(key)) {
        result[key] = val
      }
    }
  }

  // Add profile-specific env overrides (but check blacklist)
  for (const [key, val] of Object.entries(profile.env)) {
    if (isBlacklisted(key)) {
      logger.warn({ key }, 'Worker profile env contains blacklisted variable — skipped')
      continue
    }
    result[key] = val
  }

  return result
}
