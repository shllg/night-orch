import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { ZodError } from 'zod'
import { ConfigSchema, type Config } from './schema.js'
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

  let config: Config
  try {
    config = ConfigSchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      const details = err.issues.map(
        (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
      )
      throw new ConfigError('Config validation failed', details)
    }
    throw err
  }

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
    raw,
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
