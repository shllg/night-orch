import type { RepoConfig } from '../config/schema.js'
import { validateSharedEnvironment } from './shared.js'
import { startDedicatedStack, stopDedicatedStack } from './dedicated.js'
import { setupEnvFile } from './env-file.js'
import { runBootstrapCommands } from './bootstrap.js'
import { logger } from '../utils/logger.js'
import type { CommandSpec } from '../utils/command.js'

export type EnvironmentMode = 'shared' | 'dedicated'

export interface EnvSetupResult {
  mode: EnvironmentMode
  allocatedPort: number | null
  composeProjectName: string | null
  envOverrides: Record<string, string>
}

export type WithPortAllocationLock = <T>(task: () => T | Promise<T>) => Promise<T>

/**
 * Resolve the environment mode for an issue from labels and repo config.
 */
export function resolveEnvironmentMode(
  issueLabels: string[],
  repoConfig: RepoConfig,
): EnvironmentMode {
  if (issueLabels.includes('env:dedicated')) return 'dedicated'
  if (issueLabels.includes('env:shared')) return 'shared'
  return repoConfig.environment?.defaultMode ?? 'shared'
}

/**
 * Set up the environment for a worktree.
 */
export async function setupEnvironment(params: {
  worktreePath: string
  issueNumber: number
  repoConfig: RepoConfig
  mode: EnvironmentMode
  usedPorts: number[]
  withPortAllocationLock?: WithPortAllocationLock
}): Promise<EnvSetupResult> {
  const { worktreePath, issueNumber, repoConfig, mode, usedPorts, withPortAllocationLock } = params
  const envConfig = repoConfig.environment

  if (mode === 'shared') {
    // Validate shared environment
    const shared = envConfig?.shared
    await validateSharedEnvironment(shared?.healthcheck, shared?.requireRunning ?? true)

    // Run bootstrap commands
    if (envConfig?.bootstrap) {
      await runBootstrapCommands(worktreePath, envConfig.bootstrap, 'shared')
    }

    return { mode: 'shared', allocatedPort: null, composeProjectName: null, envOverrides: {} }
  }

  // Dedicated mode
  const dedicated = envConfig?.dedicated
  if (!dedicated) {
    throw new Error(`Dedicated mode requested but no dedicated config in repo ${repoConfig.repo}`)
  }

  // Set up .env file with overrides
  const projectName = dedicated.compose.projectName.replace('{issue}', String(issueNumber))
  const runSetupEnvFile = () => setupEnvFile({
    worktreePath,
    repoLocalPath: repoConfig.localPath,
    copyFrom: dedicated.env.copyFrom,
    overrides: substituteIssue(dedicated.env.overrides, issueNumber),
    overrideFiles: dedicated.env.overrideFiles,
    usedPorts,
  })
  const { envOverrides, allocatedPort } = withPortAllocationLock
    ? await withPortAllocationLock(runSetupEnvFile)
    : runSetupEnvFile()

  // Resolve healthcheck port
  const healthcheck = substituteCommandToken(
    dedicated.healthcheck,
    '{port}',
    String(allocatedPort ?? ''),
  )

  // Start Docker Compose
  let stackStarted = false
  try {
    await startDedicatedStack({
      worktreePath,
      composeFile: dedicated.compose.file,
      services: dedicated.compose.services,
      projectName,
      healthcheck,
    })
    stackStarted = true

    // Run bootstrap commands
    if (envConfig?.bootstrap) {
      await runBootstrapCommands(worktreePath, envConfig.bootstrap, 'dedicated')
    }
  } catch (err) {
    if (stackStarted) {
      try {
        await stopDedicatedStack(worktreePath, dedicated.compose.file, projectName)
      } catch (teardownErr) {
        logger.warn({ projectName, err: teardownErr }, 'Failed to roll back dedicated environment after setup error')
      }
    }
    throw err
  }

  return { mode: 'dedicated', allocatedPort, composeProjectName: projectName, envOverrides }
}

/**
 * Tear down the environment. No-op for shared mode.
 */
export async function teardownEnvironment(params: {
  worktreePath: string
  issueNumber: number
  repoConfig: RepoConfig
  mode: EnvironmentMode
  composeProjectName: string | null
}): Promise<void> {
  const { worktreePath, repoConfig, mode, composeProjectName } = params

  if (mode === 'shared') return

  const dedicated = repoConfig.environment?.dedicated
  if (!dedicated || !composeProjectName) return

  if (dedicated.teardownOnComplete) {
    await stopDedicatedStack(worktreePath, dedicated.compose.file, composeProjectName)
  }

  // Run cleanup commands
  const cleanupCmds = repoConfig.environment?.cleanup ?? []
  if (cleanupCmds.length > 0) {
    await runBootstrapCommands(worktreePath, cleanupCmds, 'dedicated')
  }

  logger.info({ composeProjectName }, 'Dedicated environment torn down')
}

function substituteIssue(overrides: Record<string, string>, issueNumber: number): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value.replace('{issue}', String(issueNumber))
  }
  return result
}

function substituteCommandToken(command: CommandSpec | undefined, token: string, value: string): CommandSpec | undefined {
  if (!command) return undefined
  if (Array.isArray(command)) {
    return command.map((part) => part.replaceAll(token, value))
  }
  return command.replaceAll(token, value)
}
