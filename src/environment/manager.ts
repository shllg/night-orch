import type { RepoConfig } from '../config/schema.js'
import { logger } from '../utils/logger.js'
import { allocatePort } from './port.js'
import { runRunHooks, type RunHookCommand } from './hooks.js'
import { defaultProjectName, type RunTokens } from './tokens.js'

export interface EnvSetupResult {
  tokens: RunTokens
}

/**
 * Allocate the per-run environment tokens (`{issue}`/`{run}`/`{project}` plus
 * one host port per configured pool: `{port}` and `{port:NAME}`).
 *
 * Each pool port is probed for host bindability before being handed out, so this
 * does light network I/O (no subprocess). The caller records the result (and
 * reaches teardown in its `finally`) BEFORE the `check`/`beforeRun` hooks run —
 * if a hook then throws, `afterRun` still runs. Allocated ports are appended to
 * `usedPorts` so concurrent runs in the same poll pass never collide; release
 * them on run end with {@link releaseEnvironmentPorts}.
 */
export async function prepareEnvironment(params: {
  repo: string
  issueNumber: number
  runId: string
  repoConfig: RepoConfig
  usedPorts: number[]
}): Promise<EnvSetupResult> {
  const { repo, issueNumber, runId, repoConfig, usedPorts } = params
  const env = repoConfig.environment

  let port: number | undefined
  let ports: Record<string, number> | undefined
  // Pool order follows config key order — the first key is the `{port}` default.
  const poolEntries = env?.ports ? Object.entries(env.ports) : []
  if (poolEntries.length > 0) {
    ports = {}
    for (const [name, range] of poolEntries) {
      // allocatePort probes host availability and pushes the chosen port into
      // usedPorts itself — do not push again here.
      ports[name] = await allocatePort(range, usedPorts)
    }
    port = ports[poolEntries[0]![0]]
  }

  const tokens: RunTokens = {
    issue: issueNumber,
    run: runId.replace(/^run-/i, '').toLowerCase(),
    port,
    ...(ports ? { ports } : {}),
    project: defaultProjectName(repo, issueNumber, runId),
  }

  return { tokens }
}

/**
 * Release a run's allocated host ports back into the poll-pass pool so a later
 * run in the same pass can reuse them. Called from the dispatcher's `finally`.
 * Idempotent — removing a port not present is a no-op.
 */
export function releaseEnvironmentPorts(usedPorts: number[], tokens: RunTokens): void {
  const allocated = new Set<number>()
  if (tokens.ports) for (const value of Object.values(tokens.ports)) allocated.add(value)
  if (tokens.port !== undefined) allocated.add(tokens.port)
  if (allocated.size === 0) return
  for (let i = usedPorts.length - 1; i >= 0; i--) {
    if (allocated.has(usedPorts[i]!)) usedPorts.splice(i, 1)
  }
}

/**
 * Run the repo's `check` hooks (fail-fast) after port allocation and before
 * `beforeRun`. Use to validate the environment (docker up, a port reachable)
 * and fail the run loudly+early rather than letting services fall over later.
 */
export async function runCheckHooks(params: {
  worktreePath: string
  repoConfig: RepoConfig
  tokens: RunTokens
}): Promise<void> {
  const hooks = (params.repoConfig.environment?.check ?? []) as RunHookCommand[]
  if (hooks.length === 0) return
  await runRunHooks(params.worktreePath, hooks, params.tokens, 'fail-fast')
}

/** Run the repo's `beforeRun` hooks (fail-fast) with token substitution. */
export async function runBeforeRunHooks(params: {
  worktreePath: string
  repoConfig: RepoConfig
  tokens: RunTokens
}): Promise<void> {
  const hooks = (params.repoConfig.environment?.beforeRun ?? []) as RunHookCommand[]
  if (hooks.length === 0) return
  await runRunHooks(params.worktreePath, hooks, params.tokens, 'fail-fast')
}

/**
 * Run the repo's `afterRun` hooks (attempt-all, never throws). Called from the
 * caller's `finally` so teardown happens on success, block, error, or
 * exception — and even when `beforeRun` failed.
 */
export async function teardownEnvironment(params: {
  worktreePath: string
  repoConfig: RepoConfig
  tokens: RunTokens
}): Promise<void> {
  const hooks = (params.repoConfig.environment?.afterRun ?? []) as RunHookCommand[]
  if (hooks.length === 0) return
  await runRunHooks(params.worktreePath, hooks, params.tokens, 'attempt-all')
  logger.info({ project: params.tokens.project }, 'Environment torn down')
}
