import { execFile } from 'node:child_process'
import type { Config, RepoConfig } from '../config/schema.js'
import { buildLabelBootstrapDefinitions } from '../labels/bootstrap.js'

const GH_LABEL_COMMAND_TIMEOUT_MS = 20_000

interface LabelCreateError {
  label: string
  message: string
}

export interface LabelsInitRepoResult {
  repo: string
  forge: RepoConfig['forge']
  skipped: boolean
  skipReason: string | null
  ghRepo: string | null
  labelsTotal: number
  labelsProcessed: number
  failures: number
  errors: LabelCreateError[]
  dryRunCommands: string[]
}

export interface LabelsInitResult {
  targetRepo: string | null
  dryRun: boolean
  selectedRepos: number
  githubRepos: number
  skippedRepos: number
  labelsProcessed: number
  failures: number
  repos: LabelsInitRepoResult[]
}

export interface LabelsInitOptions {
  targetRepo?: string
  dryRun?: boolean
  timeoutMs?: number
}

type GhLabelCreateExecutor = (args: string[], timeoutMs: number) => Promise<void>

export class LabelsInitEngine {
  constructor(
    private readonly config: Pick<Config, 'github' | 'repos'>,
    private readonly runGhLabelCreate: GhLabelCreateExecutor = defaultGhLabelCreateExecutor,
  ) {}

  async run(options: LabelsInitOptions = {}): Promise<LabelsInitResult> {
    const dryRun = options.dryRun ?? false
    const repos = selectRepos(this.config.repos, options.targetRepo)
    if (options.targetRepo && repos.length === 0) {
      throw new Error(`Repository not found in config: ${options.targetRepo}`)
    }

    const result: LabelsInitResult = {
      targetRepo: options.targetRepo ?? null,
      dryRun,
      selectedRepos: repos.length,
      githubRepos: 0,
      skippedRepos: 0,
      labelsProcessed: 0,
      failures: 0,
      repos: [],
    }

    for (const repoConfig of repos) {
      if (repoConfig.forge !== 'github') {
        result.skippedRepos += 1
        result.repos.push({
          repo: repoConfig.repo,
          forge: repoConfig.forge,
          skipped: true,
          skipReason: `forge=${repoConfig.forge} (gh label create is GitHub-only)`,
          ghRepo: null,
          labelsTotal: 0,
          labelsProcessed: 0,
          failures: 0,
          errors: [],
          dryRunCommands: [],
        })
        continue
      }

      result.githubRepos += 1
      const repoResult = await this.processGithubRepo(
        repoConfig,
        this.config.github.apiBaseUrl,
        dryRun,
        options.timeoutMs ?? GH_LABEL_COMMAND_TIMEOUT_MS,
      )
      result.labelsProcessed += repoResult.labelsProcessed
      result.failures += repoResult.failures
      result.repos.push(repoResult)
    }

    if (result.githubRepos === 0) {
      throw new Error('No GitHub repositories selected from config')
    }

    return result
  }

  private async processGithubRepo(
    repoConfig: RepoConfig,
    defaultApiBaseUrl: string,
    dryRun: boolean,
    timeoutMs: number,
  ): Promise<LabelsInitRepoResult> {
    const ghRepo = toGhRepoSelector(repoConfig, defaultApiBaseUrl)
    const definitions = buildLabelBootstrapDefinitions({
      labels: repoConfig.labels,
      labelConfig: repoConfig.labelConfig ?? {},
      kanban: repoConfig.kanban,
    })
    const repoResult: LabelsInitRepoResult = {
      repo: repoConfig.repo,
      forge: repoConfig.forge,
      skipped: false,
      skipReason: null,
      ghRepo,
      labelsTotal: definitions.length,
      labelsProcessed: 0,
      failures: 0,
      errors: [],
      dryRunCommands: [],
    }

    for (const label of definitions) {
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
        repoResult.labelsProcessed += 1
        repoResult.dryRunCommands.push(`gh ${args.map(shellQuote).join(' ')}`)
        continue
      }

      try {
        await this.runGhLabelCreate(args, timeoutMs)
        repoResult.labelsProcessed += 1
      } catch (err) {
        repoResult.failures += 1
        repoResult.errors.push({
          label: label.name,
          message: execErrorMessage(err),
        })
      }
    }

    return repoResult
  }
}

export function formatLabelsInitSummary(result: Pick<LabelsInitResult, 'labelsProcessed' | 'failures' | 'skippedRepos'>): string {
  return `labels-init complete: ${result.labelsProcessed} labels processed, ${result.failures} failures, ${result.skippedRepos} repos skipped`
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

async function defaultGhLabelCreateExecutor(args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('gh', args, { timeout: timeoutMs }, (err) => {
      if (err) {
        reject(err instanceof Error ? err : new Error('Unknown execFile error'))
        return
      }
      resolve()
    })
  })
}
