import type { RepoConfig } from '../config/schema.js'
import { validateSharedEnvironment } from './shared.js'
import { startDedicatedStack, stopDedicatedStack } from './dedicated.js'
import { setupEnvFile } from './env-file.js'
import { runBootstrapCommands } from './bootstrap.js'
import { logger } from '../utils/logger.js'

export type EnvironmentMode = 'shared' | 'dedicated'

export interface EnvSetupResult {
  mode: EnvironmentMode
  allocatedPort: number | null
  composeProjectName: string | null
  envOverrides: Record<string, string>
}

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
}): Promise<EnvSetupResult> {
  const { worktreePath, issueNumber, repoConfig, mode, usedPorts } = params
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
  const { envOverrides, allocatedPort } = setupEnvFile({
    worktreePath,
    repoLocalPath: repoConfig.localPath,
    copyFrom: dedicated.env.copyFrom,
    overrides: substituteIssue(dedicated.env.overrides, issueNumber),
    overrideFiles: dedicated.env.overrideFiles,
    usedPorts,
  })

  // Resolve healthcheck port
  const healthcheck = dedicated.healthcheck?.replace('{port}', String(allocatedPort ?? ''))

  // Start Docker Compose
  await startDedicatedStack({
    worktreePath,
    composeFile: dedicated.compose.file,
    services: dedicated.compose.services,
    projectName,
    healthcheck,
  })

  // Run bootstrap commands
  if (envConfig?.bootstrap) {
    await runBootstrapCommands(worktreePath, envConfig.bootstrap, 'dedicated')
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
