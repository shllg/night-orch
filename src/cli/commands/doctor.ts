import { existsSync, accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { logger } from '../../utils/logger.js'
import type { Config } from '../../config/schema.js'
import { parseCommandSpec } from '../../utils/command.js'

const execFileAsync = promisify(execFile)

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

interface CheckResult {
  name: string
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

  // 2. Required env vars
  const tokenEnv = config.github.tokenEnv
  if (process.env[tokenEnv]) {
    results.push({ name: `Env: ${tokenEnv}`, passed: true, message: 'Set' })
  } else {
    results.push({ name: `Env: ${tokenEnv}`, passed: false, message: 'Not set' })
  }

  for (const channel of config.notifications.channels) {
    if (channel.type === 'webhook' && 'urlEnv' in channel) {
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

  // 4. CLI binaries
  const checkedBinaries = new Set<string>()
  for (const profile of Object.values(config.workerProfiles)) {
    if (checkedBinaries.has(profile.command)) continue
    checkedBinaries.add(profile.command)

    const version = await checkBinary(profile.command)
    if (version) {
      results.push({ name: `CLI: ${profile.command}`, passed: true, message: version })
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

  // 7. DB writable
  try {
    const db = initDatabase(config.storage.dbPath)
    db.close()
    results.push({ name: 'Database', passed: true, message: `Initialized at ${config.storage.dbPath}` })
  } catch (err) {
    results.push({ name: 'Database', passed: false, message: (err as Error).message })
  }

  // 8. Verify commands
  for (const repo of config.repos) {
    for (const verifyCmd of repo.verify) {
      try {
        const { binary } = parseCommandSpec(verifyCmd)
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

  // 9. Optional: firejail
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

  printResults(results)
}

async function checkBinary(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(name, ['--version'], { timeout: 5000 })
    return stdout.trim().split('\n')[0] ?? 'found'
  } catch {
    // Some tools use --version on stderr or exit with non-zero
    try {
      const { stdout } = await execFileAsync('which', [name], { timeout: 5000 })
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
