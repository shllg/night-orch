import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RepoConfig } from '../../config/schema.js'
import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { buildLabelBootstrapDefinitions } from '../../labels/bootstrap.js'

const execFileAsync = promisify(execFile)

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

export async function labelsInitCommand(targetRepo?: string, globalOpts?: GlobalOpts): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false

  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`)
      if (err.details) err.details.forEach((d) => process.stderr.write(`${d}\n`))
    } else {
      process.stderr.write(`${(err as Error).message}\n`)
    }
    process.exitCode = 1
    return
  }

  const repos = selectRepos(config.repos, targetRepo)
  if (targetRepo && repos.length === 0) {
    process.stderr.write(`Repository not found in config: ${targetRepo}\n`)
    process.exitCode = 1
    return
  }

  let githubRepos = 0
  let createdOrUpdated = 0
  let failed = 0
  let skipped = 0

  for (const repoConfig of repos) {
    if (repoConfig.forge !== 'github') {
      process.stdout.write(`Skipping ${repoConfig.repo}: forge=${repoConfig.forge} (gh label create is GitHub-only)\n`)
      skipped += 1
      continue
    }
    githubRepos += 1

    const ghRepo = toGhRepoSelector(repoConfig, config.github.apiBaseUrl)
    const labels = buildLabelBootstrapDefinitions(repoConfig)
    process.stdout.write(`Bootstrapping ${labels.length} labels for ${repoConfig.repo}\n`)

    for (const label of labels) {
      const args = [
        'label',
        'create',
        label.name,
        '--repo',
        ghRepo,
        '--color',
        label.color,
        '--description',
        label.description,
        '--force',
      ]

      if (dryRun) {
        process.stdout.write(`[dry-run] gh ${args.map(shellQuote).join(' ')}\n`)
        createdOrUpdated += 1
        continue
      }

      try {
        await execFileAsync('gh', args, { timeout: 20_000 })
        createdOrUpdated += 1
      } catch (err) {
        failed += 1
        process.stderr.write(`Failed ${repoConfig.repo} label "${label.name}": ${execErrorMessage(err)}\n`)
      }
    }
  }

  if (githubRepos === 0) {
    process.stderr.write('No GitHub repositories selected from config\n')
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `labels-init complete: ${createdOrUpdated} labels processed, ${failed} failures, ${skipped} repos skipped\n`,
  )

  if (failed > 0) {
    process.exitCode = 1
  }
}

function selectRepos(repos: RepoConfig[], targetRepo?: string): RepoConfig[] {
  if (!targetRepo) return repos
  return repos.filter((repo) => repo.repo === targetRepo)
}

function toGhRepoSelector(repoConfig: RepoConfig, defaultApiBaseUrl: string): string {
  const apiBaseUrl = repoConfig.apiBaseUrl ?? defaultApiBaseUrl
  const host = new URL(apiBaseUrl).host
  if (host === 'api.github.com' || host === 'github.com') {
    return repoConfig.repo
  }
  return `${host}/${repoConfig.repo}`
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function execErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const stderr = 'stderr' in err && typeof err.stderr === 'string' ? err.stderr.trim() : ''
    const message = 'message' in err && typeof err.message === 'string' ? err.message : 'Unknown error'
    if (stderr.length > 0) return stderr
    return message
  }
  return String(err)
}
