import { delimiter, join } from 'node:path'
import type { WorkerProfileInput } from './types.js'
import { logger } from '../utils/logger.js'

export const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  // Set by config/loader.ts to the configured storage.worktreeRoot so mise
  // auto-trusts any `.mise.toml` / `.tool-versions` checked out in a worktree.
  // Without this, tool invocations that go through mise shims fail with
  // "Config files ... are not trusted" before the command even runs.
  'MISE_TRUSTED_CONFIG_PATHS',
] as const

export const ENV_BLACKLIST_EXACT = new Set([
  'GITHUB_TOKEN', 'GH_TOKEN', 'FORGEJO_TOKEN',
  'NIGHT_ORCH_WEBHOOK_URL',
  // Phase 3: direct-LLM API keys must never reach CLI workers.
  // The pattern rules below already catch `*_API_KEY` but explicit
  // entries document intent and survive pattern reshuffling.
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_API_KEY',
  // Phase 2c: VAPID private key for Web Push signing.
  'NIGHT_ORCH_VAPID_PRIVATE',
])

// Use word-boundary matches so legitimate vars with these substrings
// (e.g. USER_KEYBOARD_LAYOUT, NODE_ENV) are not false-flagged. The
// boundary is either string start/end or an underscore.
export const ENV_BLACKLIST_PATTERNS = [
  /(?:^|_)TOKEN(?:$|_)/i,
  /(?:^|_)SECRET(?:$|_)/i,
  /(?:^|_)PASSWORD(?:$|_)/i,
  /(?:^|_)AUTH(?:$|_)/i,
  /(?:^|_)CREDENTIAL(?:$|_)/i,
  /(?:^|_)KEY(?:$|_)/i,
  /(?:^|_)API[_]?KEY(?:$|_)/i,
  /(?:^|_)ACCESS[_]?TOKEN(?:$|_)/i,
  /^GITHUB_/i,
  /^FORGEJO_/i,
  /^GH_/i,
  // Phase 3: prefix-block every env var that starts with a
  // provider name so `ANTHROPIC_FOO`, `OPENAI_BAR`,
  // `OPENROUTER_X` all get filtered even if a new variant ships.
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^OPENROUTER_/i,
  // Phase 2c: every VAPID env var — public key is harmless but the
  // pattern keeps private/subject/public out uniformly.
  /^NIGHT_ORCH_VAPID_/i,
]

const PATH_FALLBACK_DIRS = [
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

export function isBlacklistedEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (ENV_BLACKLIST_EXACT.has(upper)) return true
  return ENV_BLACKLIST_PATTERNS.some((p) => p.test(key))
}

export function filterSafeEnv(
  values: Record<string, string>,
  warnMessage: string,
): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [key, val] of Object.entries(values)) {
    if (isBlacklistedEnvKey(key)) {
      logger.warn({ key }, warnMessage)
      continue
    }
    safe[key] = val
  }
  return safe
}

export function normalizePathForSubprocess(
  pathValue: string | undefined,
  homeValue: string | undefined,
): string {
  const segments = (pathValue ?? '')
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  const seen = new Set(segments)
  const ensureSegment = (candidate: string | undefined) => {
    if (!candidate || seen.has(candidate)) return
    segments.push(candidate)
    seen.add(candidate)
  }

  if (homeValue) {
    ensureSegment(join(homeValue, '.local/bin'))
    ensureSegment(join(homeValue, '.local/share/pnpm'))
    ensureSegment(join(homeValue, '.local/share/mise/shims'))
  }
  for (const fallback of PATH_FALLBACK_DIRS) {
    ensureSegment(fallback)
  }

  return segments.join(delimiter)
}

/**
 * Build the env vars to pass to a worker process.
 * Always uses whitelist mode for process env vars.
 * NEVER passes GITHUB_TOKEN or any forge token regardless.
 */
export function buildWorkerEnv(
  profile: WorkerProfileInput,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {}

  // Whitelist mode: only safe vars
  for (const key of ENV_WHITELIST) {
    const val = process.env[key]
    if (val !== undefined) result[key] = val
  }

  if (!profile.minimalEnv) {
    logger.warn('workerProfile.minimalEnv=false is deprecated and ignored; using whitelist-only env mode')
  }

  // Add profile-specific env overrides (but check blacklist)
  for (const [key, val] of Object.entries(filterSafeEnv(profile.env, 'Worker profile env contains blacklisted variable — skipped'))) {
    result[key] = val
  }

  // Add runtime environment overrides (for dedicated env setup, etc.)
  for (const [key, val] of Object.entries(filterSafeEnv(overrides, 'Worker runtime env override contains blacklisted variable — skipped'))) {
    result[key] = val
  }

  result['PATH'] = normalizePathForSubprocess(result['PATH'], result['HOME'] ?? process.env['HOME'])

  return result
}

// Docker/Compose engine-configuration vars (NOT secrets — they point at the
// engine, they don't authenticate to a registry). `DOCKER_AUTH_CONFIG` is a
// registry credential blob and is deliberately excluded (it also matches the
// `*AUTH*` blacklist). Verify commands carry `docker compose up/down` hooks, so
// these must be on the verifier whitelist for the hooks to reach the engine.
const DOCKER_COMPOSE_ENV = [
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_FILE',
] as const

const VERIFIER_ENV_WHITELIST = [
  ...ENV_WHITELIST,
  'CI',
  'NODE_ENV',
  'PNPM_HOME',
  'npm_config_cache',
  'npm_config_userconfig',
  ...DOCKER_COMPOSE_ENV,
] as const

/**
 * Build env vars for verifier commands.
 * Uses strict whitelist mode to avoid leaking forge and API secrets.
 */
export function buildVerifierEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of VERIFIER_ENV_WHITELIST) {
    const val = process.env[key]
    if (val !== undefined && !isBlacklistedEnvKey(key)) {
      result[key] = val
    }
  }
  for (const [key, val] of Object.entries(filterSafeEnv(overrides, 'Verifier runtime env override contains blacklisted variable — skipped'))) {
    result[key] = val
  }
  result['PATH'] = normalizePathForSubprocess(result['PATH'], result['HOME'] ?? process.env['HOME'])
  return result
}

/**
 * Build env vars for subprocesses that run inside a worktree but are not
 * workers — bootstrap scripts, healthchecks, docker compose up/down.
 *
 * These commands are user-authored AND they execute inside an attacker-
 * authored worktree (the coder worker may have written the Makefile, the
 * devcontainer config, package postinstall scripts, etc). They must NOT
 * inherit `process.env` because that would expose forge tokens, SMTP
 * creds, webhook URLs, and every other secret loaded at startup.
 *
 * The whitelist is identical to `buildVerifierEnv`'s in spirit but adds
 * `DOCKER_*` variables so compose can reach the engine configured by the
 * operator. Anything else must come through `overrides`.
 */
const BOOTSTRAP_ENV_WHITELIST = [
  ...VERIFIER_ENV_WHITELIST,
] as const

export function buildBootstrapEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of BOOTSTRAP_ENV_WHITELIST) {
    const val = process.env[key]
    if (val !== undefined && !isBlacklistedEnvKey(key)) {
      result[key] = val
    }
  }
  for (const [key, val] of Object.entries(filterSafeEnv(overrides, 'Bootstrap runtime env override contains blacklisted variable — skipped'))) {
    result[key] = val
  }
  result['PATH'] = normalizePathForSubprocess(result['PATH'], result['HOME'] ?? process.env['HOME'])
  return result
}
