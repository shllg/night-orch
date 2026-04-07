import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ZodError } from 'zod'
import { ConfigSchema, ProjectConfigSchema, type Config, type ProjectConfig } from './schema.js'
import { expandPath } from './paths.js'
import { logger } from '../utils/logger.js'

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly details?: string[],
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

export interface LoadedConfig {
  raw: unknown
  config: Config
}

const PROJECT_CONFIG_FILENAMES = ['.night-orch.yml', '.night-orch.yaml'] as const
const PROJECT_TOP_LEVEL_KEYS = new Set<keyof Pick<ProjectConfig, 'workflows' | 'workerProfiles'>>([
  'workflows',
  'workerProfiles',
])

/**
 * Load and validate config from a YAML file.
 * Expands all path fields (~, $ENV).
 */
export function loadConfig(configPath: string): Config {
  return loadConfigWithRaw(configPath).config
}

export function loadConfigWithRaw(configPath: string): LoadedConfig {
  const resolvedPath = expandPath(configPath)
  const raw = loadRawConfig(resolvedPath)
  const lookupConfig = expandConfigPaths(parseConfig(raw))
  const mergedRaw = mergeProjectConfigs(raw, lookupConfig.repos)
  let config = parseConfig(mergedRaw)

  // Expand paths
  config = expandConfigPaths(config)

  // Pre-trust mise config files inside any night-orch worktree so bootstrap
  // commands and workers can use mise-managed tools (bundle, node, rake, ...)
  // without a manual `mise trust`. Setting this on process.env propagates to
  // every subprocess spawned afterwards.
  registerMiseTrustedPath(config.storage.worktreeRoot)

  // Validate worker profile references
  validateWorkerProfileRefs(config)

  logger.debug({ configPath: resolvedPath }, 'Config loaded successfully')
  return {
    raw: mergedRaw,
    config,
  }
}

export function loadRawConfig(configPath: string): unknown {
  const resolvedPath = expandPath(configPath)

  if (!existsSync(resolvedPath)) {
    throw new ConfigError(`Config file not found: ${resolvedPath}`)
  }

  try {
    const content = readFileSync(resolvedPath, 'utf-8')
    return parseYaml(content)
  } catch (err) {
    throw new ConfigError(
      `Failed to parse YAML config: ${resolvedPath}`,
      [(err as Error).message],
    )
  }
}

function expandConfigPaths(config: Config): Config {
  return {
    ...config,
    storage: {
      ...config.storage,
      dbPath: expandPath(config.storage.dbPath),
      worktreeRoot: expandPath(config.storage.worktreeRoot),
      logsRoot: expandPath(config.storage.logsRoot),
    },
    repos: config.repos.map((repo) => ({
      ...repo,
      localPath: expandPath(repo.localPath),
    })),
  }
}

function parseConfig(raw: unknown): Config {
  try {
    return ConfigSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      const details = err.issues.map(
        (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
      )
      throw new ConfigError('Config validation failed', details)
    }
    throw err
  }
}

function mergeProjectConfigs(rawConfig: unknown, repos: Config['repos']): unknown {
  if (repos.length === 0) return rawConfig
  if (!isRecord(rawConfig)) return rawConfig

  const mergedRoot: Record<string, unknown> = { ...rawConfig }
  const rawReposValue = rawConfig['repos']
  const rawRepos: unknown[] = isUnknownArray(rawReposValue) ? [...rawReposValue] : []
  let hasOverrides = false

  repos.forEach((repo, index) => {
    const projectConfigPath = resolveProjectConfigPath(repo.localPath)
    if (!projectConfigPath) return

    const projectConfig = loadProjectConfig(projectConfigPath, repo.repo)
    const { topLevelOverride, repoOverride } = splitProjectConfig(projectConfig)

    for (const [key, override] of Object.entries(topLevelOverride)) {
      const current = mergedRoot[key]
      mergedRoot[key] = deepMerge(current, override)
    }

    if (Object.keys(repoOverride).length > 0) {
      const existingRepo = rawRepos[index]
      rawRepos[index] = deepMerge(existingRepo, repoOverride)
    }

    hasOverrides = true
  })

  if (!hasOverrides) return rawConfig
  mergedRoot['repos'] = rawRepos
  return mergedRoot
}

function resolveProjectConfigPath(repoLocalPath: string): string | null {
  const candidates = PROJECT_CONFIG_FILENAMES.map((name) => join(repoLocalPath, name))
  const existing = candidates.filter((candidate) => existsSync(candidate))

  if (existing.length > 1) {
    throw new ConfigError(
      `Multiple project config files found in ${repoLocalPath}: ${PROJECT_CONFIG_FILENAMES.join(', ')}`,
      ['Keep only one project config file to avoid ambiguity.'],
    )
  }

  return existing[0] ?? null
}

function loadProjectConfig(projectConfigPath: string, repo: string): ProjectConfig {
  let parsed: unknown

  try {
    const content = readFileSync(projectConfigPath, 'utf-8')
    parsed = parseYaml(content)
  } catch (err) {
    throw new ConfigError(
      `Failed to parse project config for ${repo}: ${projectConfigPath}`,
      [(err as Error).message],
    )
  }

  const normalized = parsed ?? {}

  try {
    const loaded = ProjectConfigSchema.parse(normalized)
    logger.debug({ repo, projectConfigPath }, 'Loaded project config override')
    return loaded
  } catch (err) {
    if (err instanceof ZodError) {
      const details = err.issues.map((issue) => {
        const path = issue.path.join('.')
        const location = path.length > 0 ? path : '(root)'
        return `  ${location}: ${issue.message}`
      })
      throw new ConfigError(
        `Project config validation failed for ${repo}: ${projectConfigPath}`,
        details,
      )
    }
    throw err
  }
}

function splitProjectConfig(projectConfig: ProjectConfig): {
  topLevelOverride: Record<string, unknown>
  repoOverride: Record<string, unknown>
} {
  const topLevelOverride: Record<string, unknown> = {}
  const repoOverride: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(projectConfig)) {
    if (PROJECT_TOP_LEVEL_KEYS.has(key as keyof Pick<ProjectConfig, 'workflows' | 'workerProfiles'>)) {
      topLevelOverride[key] = value
      continue
    }
    repoOverride[key] = value
  }

  return { topLevelOverride, repoOverride }
}

function deepMerge(baseValue: unknown, overrideValue: unknown): unknown {
  if (overrideValue === undefined) return cloneValue(baseValue)

  if (Array.isArray(overrideValue)) {
    return overrideValue.map((item) => cloneValue(item))
  }

  if (isRecord(overrideValue) && isRecord(baseValue)) {
    const merged: Record<string, unknown> = { ...baseValue }
    for (const [key, value] of Object.entries(overrideValue)) {
      merged[key] = deepMerge(baseValue[key], value)
    }
    return merged
  }

  if (isRecord(overrideValue)) {
    const merged: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(overrideValue)) {
      merged[key] = cloneValue(value)
    }
    return merged
  }

  return cloneValue(overrideValue)
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item))
  }
  if (isRecord(value)) {
    const cloned: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      cloned[key] = cloneValue(nested)
    }
    return cloned
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function registerMiseTrustedPath(worktreeRoot: string): void {
  const existing = process.env['MISE_TRUSTED_CONFIG_PATHS'] ?? ''
  const parts = existing.length > 0 ? existing.split(':') : []
  if (parts.includes(worktreeRoot)) return
  parts.push(worktreeRoot)
  process.env['MISE_TRUSTED_CONFIG_PATHS'] = parts.join(':')
}

function validateWorkerProfileRefs(config: Config): void {
  const profileNames = new Set(Object.keys(config.workerProfiles))

  for (const repo of config.repos) {
    for (const [agentName, profileRef] of Object.entries(repo.agents)) {
      if (!profileNames.has(profileRef)) {
        throw new ConfigError(
          `Repo ${repo.repo}: agent "${agentName}" references unknown worker profile "${profileRef}". Available: ${[...profileNames].join(', ')}`,
        )
      }
    }
  }

  for (const [workflowName, workflow] of Object.entries(config.workflows)) {
    for (const [agentName, profileRef] of Object.entries(workflow.agents ?? {})) {
      if (!profileNames.has(profileRef)) {
        throw new ConfigError(
          `Workflow ${workflowName}: agent "${agentName}" references unknown worker profile "${profileRef}". Available: ${[...profileNames].join(', ')}`,
        )
      }
    }
  }
}

/**
 * Resolve the config file path from CLI flag or default locations.
 */
export function resolveConfigPath(
  cliPath?: string,
  opts: { trustWorkspace?: boolean } = {},
): string {
  if (cliPath) return cliPath

  const defaults = [
    'config.yaml',
    'config.yml',
    '~/.night-orch/config.yaml',
    '~/.night-orch/config.yml',
    '~/.config/night-orch/config.yaml',
    '~/.config/night-orch/config.yml',
  ]

  if (opts.trustWorkspace) {
    defaults.unshift('.night-orch.yml')
    defaults.unshift('.night-orch.yaml')
  }

  for (const candidate of defaults) {
    try {
      const expanded = expandPath(candidate)
      if (existsSync(expanded)) return expanded
    } catch {
      // env var not set, skip this candidate
    }
  }

  throw new ConfigError(
    opts.trustWorkspace
      ? 'No config file found. Provide --config, create config.yaml in the current directory, create ~/.night-orch/config.yaml, or create ~/.config/night-orch/config.yaml'
      : 'No config file found. Provide --config, use config.yaml in the current directory, use ~/.night-orch/config.yaml, use ~/.config/night-orch/config.yaml, or pass --trust-workspace to allow .night-orch.yaml from the current directory',
  )
}
