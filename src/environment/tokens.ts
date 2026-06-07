import type { CommandSpec } from '../utils/command.js'

/**
 * Per-run substitution tokens, allocated once per run and expanded into verify
 * command hooks (`before`/`after`), command `env`, and run-level hooks.
 *
 * `run` is the per-run discriminator — use it (not `issue`) in resource names
 * like test-DB names so two concurrent runs of the same issue never collide.
 * `port` is the first/default pool's host port (the bare `{port}` token),
 * present only when at least one pool is configured. `ports` maps each named
 * pool to its allocated host port (the `{port:NAME}` tokens).
 */
export interface RunTokens {
  issue: number
  run: string
  port?: number
  ports?: Record<string, number>
  project: string
}

/** Matches an unresolved `{port}` or `{port:NAME}` token. */
const PORT_TOKEN_RE = /\{port(?::([a-zA-Z0-9_-]+))?\}/

/** Expand `{issue}`/`{run}`/`{project}`/`{port}`/`{port:NAME}` in a string. */
export function substituteTokens(input: string, tokens: RunTokens): string {
  let out = input
  out = out.replaceAll('{issue}', String(tokens.issue))
  out = out.replaceAll('{run}', tokens.run)
  out = out.replaceAll('{project}', tokens.project)
  if (tokens.port !== undefined) out = out.replaceAll('{port}', String(tokens.port))
  if (tokens.ports) {
    for (const [name, value] of Object.entries(tokens.ports)) {
      out = out.replaceAll(`{port:${name}}`, String(value))
    }
  }
  return out
}

/**
 * Return the first unresolved port token across the given segments, or `null`
 * if every port token was substituted. Used to fail loudly when a command
 * references `{port}` with no pool configured, or `{port:NAME}` naming an
 * unknown pool.
 */
export function findUnresolvedPortToken(segments: readonly string[]): string | null {
  for (const segment of segments) {
    const match = segment.match(PORT_TOKEN_RE)
    if (match) return match[0]
  }
  return null
}

/**
 * Build the "fix your config" message for an unresolved port token, listing the
 * pools that ARE configured so the operator can spot a typo or missing pool.
 */
export function unresolvedPortMessage(token: string, tokens: RunTokens | undefined, context: string): string {
  const pools = tokens?.ports ? Object.keys(tokens.ports) : []
  const configured = pools.length > 0
    ? `Configured pools: ${pools.join(', ')}.`
    : 'No `environment.ports` pool is configured.'
  return `${context} references the ${token} token but it could not be resolved. ${configured} Add it under \`environment.ports\`.`
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
