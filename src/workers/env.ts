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
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /AUTH/i,
  /CREDENTIAL/i,
  /KEY/i,
  /^GITHUB_/i,
  /^FORGEJO_/i,
  /^GH_/i,
]

function isBlacklisted(key: string): boolean {
  const upper = key.toUpperCase()
  if (ENV_BLACKLIST_EXACT.has(upper)) return true
  return ENV_BLACKLIST_PATTERNS.some((p) => p.test(key))
}

/**
 * Build the env vars to pass to a worker process.
 * NEVER passes full process.env when minimalEnv is true.
 * NEVER passes GITHUB_TOKEN or any forge token regardless.
 */
export function buildWorkerEnv(
  profile: WorkerProfileInput,
  overrides: Record<string, string> = {},
): Record<string, string> {
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

  // Add runtime environment overrides (for dedicated env setup, etc.)
  for (const [key, val] of Object.entries(overrides)) {
    if (isBlacklisted(key)) {
      logger.warn({ key }, 'Worker runtime env override contains blacklisted variable — skipped')
      continue
    }
    result[key] = val
  }

  return result
}

const VERIFIER_ENV_WHITELIST = [
  ...ENV_WHITELIST,
  'CI',
  'NODE_ENV',
  'PNPM_HOME',
  'npm_config_cache',
  'npm_config_userconfig',
] as const

/**
 * Build env vars for verifier commands.
 * Uses strict whitelist mode to avoid leaking forge and API secrets.
 */
export function buildVerifierEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of VERIFIER_ENV_WHITELIST) {
    const val = process.env[key]
    if (val !== undefined && !isBlacklisted(key)) {
      result[key] = val
    }
  }
  for (const [key, val] of Object.entries(overrides)) {
    if (isBlacklisted(key)) {
      logger.warn({ key }, 'Verifier runtime env override contains blacklisted variable — skipped')
      continue
    }
    result[key] = val
  }
  return result
}
