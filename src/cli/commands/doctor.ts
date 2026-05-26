import { existsSync, accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { logger } from '../../utils/logger.js'
import type { Config } from '../../config/schema.js'
import { parseCommandSpec } from '../../utils/command.js'
import { normalizePathForSubprocess } from '../../workers/env.js'
import { resolveConfigWithRuntimeSettings } from '../../settings/runtime.js'

const execFileAsync = promisify(execFile)

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
  project?: string
}

interface CheckResult {
  name: string
  passed: boolean
  message: string
  optional?: boolean
}

interface ProviderProbeResult {
  passed: boolean
  message: string
  optional?: boolean
}

export async function doctorCommand(globalOpts?: GlobalOpts): Promise<void> {
  const results: CheckResult[] = []

  // 1. Config
  let config: Config | null = null
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
    results.push({ name: 'Config', passed: true, message: `Loaded from ${configPath}` })
  } catch (err) {
    const msg = err instanceof ConfigError
      ? `${err.message}${err.details ? '\n' + err.details.join('\n') : ''}`
      : (err as Error).message
    results.push({ name: 'Config', passed: false, message: msg })
  }

  if (!config) {
    printResults(results)
    return
  }

  let runtimeConfig: Config = config

  // If --project specified, run project-specific validation for that repo
  if (globalOpts?.project) {
    const targetRepo = config.repos.find((r) => r.repo === globalOpts.project)
    if (!targetRepo) {
      results.push({ name: 'Project lookup', passed: false, message: `Repo '${globalOpts.project}' not found in config. Available: ${config.repos.map(r => r.repo).join(', ')}` })
      printResults(results)
      return
    }

    const { createForgeAdapter } = await import('../../forge/factory.js')
    const { validateProjectSetup } = await import('../../ops/project-check.js')
    const forge = createForgeAdapter(targetRepo, config)
    const projectResults = await validateProjectSetup(targetRepo, config, forge)
    for (const pr of projectResults) {
      results.push(pr)
    }
    printResults(results)
    return
  }

  // 2. Required env vars
  const tokenEnv = config.github.tokenEnv
  if (process.env[tokenEnv]) {
    results.push({ name: `Env: ${tokenEnv}`, passed: true, message: 'Set' })
  } else {
    results.push({ name: `Env: ${tokenEnv}`, passed: false, message: 'Not set' })
  }

  for (const channel of config.notifications.channels) {
    if ((channel.type === 'webhook' || channel.type === 'discord') && 'urlEnv' in channel) {
      const envName = channel.urlEnv
      if (process.env[envName]) {
        results.push({ name: `Env: ${envName}`, passed: true, message: 'Set' })
      } else {
        results.push({ name: `Env: ${envName}`, passed: false, message: 'Not set' })
      }
    }
  }

  // 3. Forge auth (per repo)
  const { createForgeAdapter } = await import('../../forge/factory.js')
  const checkedTokens = new Set<string>()
  for (const repo of config.repos) {
    const repoTokenEnv = repo.tokenEnv ?? (repo.forge === 'forgejo' ? 'FORGEJO_TOKEN' : config.github.tokenEnv)
    const label = `${repo.forge} auth (${repo.repo})`

    if (!process.env[repoTokenEnv]) {
      results.push({ name: label, passed: false, message: `Cannot test — ${repoTokenEnv} not set` })
      continue
    }

    // Avoid duplicate auth checks for repos sharing the same token + forge
    const dedupeKey = `${repo.forge}:${repoTokenEnv}:${repo.apiBaseUrl ?? ''}`
    if (checkedTokens.has(dedupeKey)) continue
    checkedTokens.add(dedupeKey)

    try {
      const adapter = createForgeAdapter(repo, config)
      const auth = await adapter.validateAuth()
      results.push({ name: label, passed: true, message: `Authenticated as ${auth.user}` })
    } catch (err) {
      results.push({ name: label, passed: false, message: (err as Error).message })
    }
  }

  // 4. CLI binaries + auth status
  const { checkWorkerAuth } = await import('../../workers/auth-check.js')
  const checkedBinaries = new Set<string>()
  for (const [profileName, profile] of Object.entries(config.workerProfiles)) {
    if (checkedBinaries.has(profile.command)) continue
    checkedBinaries.add(profile.command)

    const version = await checkBinary(profile.command)
    if (version) {
      results.push({ name: `CLI: ${profile.command}`, passed: true, message: version })

      // Auth check — only meaningful if the binary exists
      const adapterType = profile.type === 'codex' ? 'codex' : 'claude'
      const authResult = await checkWorkerAuth(profile.command, adapterType)
      if (authResult.authenticated) {
        results.push({ name: `Auth: ${profileName} (${profile.command})`, passed: true, message: 'Authenticated' })
      } else {
        results.push({
          name: `Auth: ${profileName} (${profile.command})`,
          passed: false,
          message: `Not authenticated. ${authResult.remediation ?? ''}`.trim(),
        })
      }
    } else {
      results.push({ name: `CLI: ${profile.command}`, passed: false, message: 'Not found on PATH' })
    }
  }

  // 5. Repo paths + base branches
  for (const repo of config.repos) {
    const gitDir = `${repo.localPath}/.git`
    if (existsSync(repo.localPath) && existsSync(gitDir)) {
      results.push({ name: `Repo: ${repo.repo}`, passed: true, message: `${repo.localPath} exists` })

      // Check base branch
      const branchExists = await checkGitBranch(repo.localPath, repo.baseBranch)
      if (branchExists) {
        results.push({
          name: `Branch: ${repo.repo}/${repo.baseBranch}`,
          passed: true,
          message: 'Exists',
        })
      } else {
        results.push({
          name: `Branch: ${repo.repo}/${repo.baseBranch}`,
          passed: false,
          message: 'Branch not found',
        })
      }
    } else {
      results.push({ name: `Repo: ${repo.repo}`, passed: false, message: `${repo.localPath} not found or not a git repo` })
    }
  }

  // 6. Worktree root writable
  try {
    const wtRoot = config.storage.worktreeRoot
    const parentDir = dirname(wtRoot)
    if (existsSync(parentDir)) {
      accessSync(parentDir, constants.W_OK)
      results.push({ name: 'Worktree root', passed: true, message: `${wtRoot} is writable` })
    } else {
      results.push({ name: 'Worktree root', passed: true, message: `${parentDir} will be created` })
    }
  } catch {
    results.push({ name: 'Worktree root', passed: false, message: 'Parent directory not writable' })
  }

  // 7. DB writable + runtime-setting resolve
  let runtimeDb: ReturnType<typeof initDatabase> | null = null
  try {
    runtimeDb = initDatabase(config.storage.dbPath)
    runtimeConfig = resolveConfigWithRuntimeSettings(config, runtimeDb)
    results.push({ name: 'Database', passed: true, message: `Initialized at ${config.storage.dbPath}` })
  } catch (err) {
    results.push({ name: 'Database', passed: false, message: (err as Error).message })
  }

  // 8. Metrics endpoint probe
  results.push(await probeMetrics(runtimeConfig))

  // 9. Verify commands
  for (const repo of config.repos) {
    for (const verifyCmd of repo.verify) {
      try {
        const commandSpec = normalizeVerifyCommandSpec(verifyCmd)
        const { binary } = parseCommandSpec(commandSpec)
        const found = await checkBinary(binary)
        if (found) {
          results.push({ name: `Verify: ${binary}`, passed: true, message: 'Found' })
        } else {
          results.push({ name: `Verify: ${binary}`, passed: false, message: 'Not found on PATH' })
        }
      } catch (err) {
        results.push({
          name: 'Verify command',
          passed: false,
          message: `Invalid command: ${(err as Error).message}`,
        })
      }
    }
  }

  // 10. Optional: firejail
  const usesFirejail = Object.values(config.workerProfiles).some(
    (p) => p.runtimeWrapper?.includes('firejail'),
  )
  if (usesFirejail) {
    const found = await checkBinary('firejail')
    if (found) {
      results.push({ name: 'firejail', passed: true, message: found, optional: true })
    } else {
      results.push({ name: 'firejail', passed: false, message: 'Not found (needed for sandboxed worker profiles)', optional: true })
    }
  }

  // 11. Direct-LLM provider probe — sends a 1-token completion to
  //     catch bad API keys and wrong model slugs at startup instead
  //     of on the first triage/reviewer call in production.
  const aiInternal = config.ai.internal
  const aiFeatureEnabled =
    aiInternal.enable.triage
    || aiInternal.enable.reviewerParseFallback
    || aiInternal.enable.prBody
    || (config.autoResolveConflicts.enabled && aiInternal.features.conflictResolver)
  let aiProviderProbe: ProviderProbeResult | null = null
  if (aiInternal.provider && aiInternal.model && aiFeatureEnabled) {
    const label = `AI provider (${aiInternal.provider} / ${aiInternal.model})`
    const { createAiClient } = await import('../../ai/factory.js')
    const {
      AiAuthError,
      AiInvalidResponseError,
      AiRateLimitError,
      AiTransientError,
    } = await import('../../ai/errors.js')
    const client = createAiClient(config)
    if (!client) {
      aiProviderProbe = {
        passed: false,
        message: `apiKeyEnv '${aiInternal.apiKeyEnv ?? '(unset)'}' not set in environment`,
      }
    } else {
      try {
        await client.complete({
          system: 'Reply with a single character.',
          user: 'ping',
          maxTokens: 1,
          temperature: 0,
          timeoutMs: 10_000,
        })
        aiProviderProbe = { passed: true, message: 'Reachable; auth + model slug OK' }
      } catch (err) {
        if (err instanceof AiAuthError) {
          aiProviderProbe = {
            passed: false,
            message: `Auth failed — check ${aiInternal.apiKeyEnv}. ${err.message}`,
          }
        } else if (err instanceof AiInvalidResponseError) {
          // OpenAI surfaces unknown-model as 404; Anthropic surfaces
          // it as 400 with an error body. Either way, the operator
          // most likely has the wrong slug.
          aiProviderProbe = {
            passed: false,
            message: `Model unavailable or invalid response — check the slug. ${err.message}`,
          }
        } else if (err instanceof AiRateLimitError) {
          aiProviderProbe = {
            passed: false,
            message: `Rate-limited by provider (HTTP 429). Configured correctly, but try again in a moment. ${err.message}`,
            optional: true,
          }
        } else if (err instanceof AiTransientError) {
          aiProviderProbe = {
            passed: false,
            message: `Transient provider error — ${err.message}`,
            optional: true,
          }
        } else {
          aiProviderProbe = {
            passed: false,
            message: (err as Error).message,
          }
        }
      }
    }

    results.push({
      name: label,
      passed: aiProviderProbe.passed,
      message: aiProviderProbe.message,
      optional: aiProviderProbe.optional,
    })
  }

  if (config.autoResolveConflicts.enabled && aiInternal.features.conflictResolver) {
    results.push({
      name: 'Conflict resolver',
      passed: aiProviderProbe?.passed ?? false,
      message: aiProviderProbe?.passed
        ? 'ready'
        : `unavailable: ${aiProviderProbe?.message ?? 'internal AI provider is not configured'}`,
      optional: aiProviderProbe?.optional,
    })
  } else {
    results.push({
      name: 'Conflict resolver',
      passed: true,
      message: 'disabled',
      optional: true,
    })
  }

  if (runtimeDb) {
    runtimeDb.close()
  }
  printResults(results)
}

async function checkBinary(name: string): Promise<string | null> {
  const env = {
    ...process.env,
    PATH: normalizePathForSubprocess(process.env['PATH'], process.env['HOME']),
  }
  try {
    const { stdout } = await execFileAsync(name, ['--version'], { timeout: 5000, env })
    return stdout.trim().split('\n')[0] ?? 'found'
  } catch {
    // Some tools use --version on stderr or exit with non-zero
    try {
      const { stdout } = await execFileAsync('which', [name], { timeout: 5000, env })
      return stdout.trim() ? 'found' : null
    } catch {
      return null
    }
  }
}

async function checkGitBranch(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`], {
      timeout: 5000,
    })
    return true
  } catch {
    return false
  }
}

async function probeMetrics(config: Config): Promise<CheckResult> {
  if (!config.metrics.enabled) {
    return {
      name: 'Metrics probe',
      passed: false,
      optional: true,
      message: 'disabled-runtime — metrics.enabled is false at runtime',
    }
  }

  const probeHost = config.metrics.host === '0.0.0.0' ? '127.0.0.1' : config.metrics.host
  const probeUrl = `http://${formatHostForUrl(probeHost)}:${config.metrics.port}/healthz`
  const timeoutMs = 3_000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(probeUrl, { signal: controller.signal })
    if (response.status !== 200) {
      return {
        name: 'Metrics probe',
        passed: false,
        message: `not-ready — ${probeUrl} returned HTTP ${response.status}`,
      }
    }

    const payload = await response.json() as { ready?: boolean }
    if (payload.ready === true) {
      return {
        name: 'Metrics probe',
        passed: true,
        message: `ok — ${probeUrl}`,
      }
    }

    return {
      name: 'Metrics probe',
      passed: false,
      message: `not-ready — ${probeUrl} reports ready=false`,
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return {
        name: 'Metrics probe',
        passed: false,
        message: `timeout — ${probeUrl} did not respond within ${timeoutMs}ms`,
      }
    }
    const code = errorCode(err)
    if (code === 'ECONNREFUSED') {
      return {
        name: 'Metrics probe',
        passed: false,
        message: "connection-refused — metrics server not running — is `night-orch run` launched?",
      }
    }
    return {
      name: 'Metrics probe',
      passed: false,
      message: `error — ${(err as Error).message}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) {
    return `[${host}]`
  }
  return host
}

function errorCode(err: unknown): string | null {
  if (isErrnoShape(err)) return err.code
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause
    if (isErrnoShape(cause)) return cause.code
  }
  return null
}

function isErrnoShape(value: unknown): value is { code: string } {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof (value as { code?: unknown }).code === 'string'
}

function normalizeVerifyCommandSpec(command: string | string[] | { command: string | string[] }): string | string[] {
  if (Array.isArray(command) || typeof command === 'string') return command
  return command.command
}

function printResults(results: CheckResult[]): void {
  console.log('\nnight-orch doctor\n')

  let passed = 0
  let failed = 0

  for (const r of results) {
    const icon = r.passed ? '✓' : '✗'
    const prefix = r.optional ? ' (optional)' : ''
    console.log(`  ${icon} ${r.name}${prefix}: ${r.message}`)
    if (r.passed) {
      passed++
    } else if (!r.optional) {
      failed++
    }
  }

  const total = passed + failed
  console.log(`\n${passed}/${total} checks passed`)

  if (failed > 0) {
    logger.error(`${failed} check(s) failed`)
    process.exitCode = 1
  }
}
