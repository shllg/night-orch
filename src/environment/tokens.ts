import type { CommandSpec } from '../utils/command.js'

/**
 * Per-run substitution tokens, allocated once per run and expanded into verify
 * command hooks (`before`/`after`), command `env`, and run-level hooks.
 *
 * `run` is the per-run discriminator — use it (not `issue`) in resource names
 * like test-DB names so two concurrent runs of the same issue never collide.
 * `port` is present only when a host port was allocated.
 */
export interface RunTokens {
  issue: number
  run: string
  port?: number
  project: string
}

/** Expand `{issue}`/`{run}`/`{port}`/`{project}` in a single string. */
export function substituteTokens(input: string, tokens: RunTokens): string {
  const map: Record<string, string> = {
    '{issue}': String(tokens.issue),
    '{run}': tokens.run,
    '{project}': tokens.project,
  }
  if (tokens.port !== undefined) map['{port}'] = String(tokens.port)

  let out = input
  for (const [token, value] of Object.entries(map)) {
    out = out.replaceAll(token, value)
  }
  return out
}

/** Expand tokens across every segment of a string- or array-form command. */
export function substituteCommandTokens(command: CommandSpec, tokens: RunTokens): CommandSpec {
  if (Array.isArray(command)) {
    return command.map((part) => substituteTokens(part, tokens))
  }
  return substituteTokens(command, tokens)
}

/** Expand tokens across every value of an env map (keys are left untouched). */
export function substituteEnvTokens(
  env: Record<string, string>,
  tokens: RunTokens,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = substituteTokens(value, tokens)
  }
  return out
}

/**
 * Default compose project name: `{repoSlug}-{issue}-{runShort}`.
 *
 * Docker project names are host-global, so issue-only names collide across
 * repos and with stale prior runs. The sanitized repo slug plus the short run
 * id keeps every concurrent run isolated.
 */
export function defaultProjectName(repo: string, issue: number, runId: string): string {
  const repoName = repo.includes('/') ? repo.slice(repo.lastIndexOf('/') + 1) : repo
  const slug = sanitizeSlug(repoName)
  const runShort = runId.replace(/^run-/i, '').toLowerCase()
  return `${slug}-${issue}-${runShort}`
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
