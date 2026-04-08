import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'
import type { UpdateStatusTracker } from './status.js'

export type InstallMode = 'git' | 'npm'

export interface UpdateCheckpoint {
  previousCommit: string
  previousRef: string | null
}

export interface UpdateResult extends UpdateCheckpoint {
  success: boolean
  newCommit: string
  error?: string
}

/** Check whether the package root is a git checkout or an npm global install. */
export function detectInstallMode(projectRoot: string): InstallMode {
  return existsSync(resolve(projectRoot, '.git')) ? 'git' : 'npm'
}

export async function runUpdate(
  projectRoot: string,
  status: UpdateStatusTracker,
): Promise<UpdateResult> {
  const mode = detectInstallMode(projectRoot)
  return mode === 'git'
    ? runGitUpdate(projectRoot, status)
    : runNpmUpdate(projectRoot, status)
}

// ---------------------------------------------------------------------------
// Git-based update (existing behaviour for development installs)
// ---------------------------------------------------------------------------

async function runGitUpdate(
  projectRoot: string,
  status: UpdateStatusTracker,
): Promise<UpdateResult> {
  const git = (args: string[]) => execa('git', args, { cwd: projectRoot })
  const previousCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const previousRefRaw = (await git(['branch', '--show-current'])).stdout.trim()
  const previousRef = previousRefRaw.length > 0 ? previousRefRaw : null

  // Pull
  status.transition('pulling', {
    installMethod: 'git',
    startedAt: nowUtcIso(),
    completedAt: undefined,
    error: undefined,
    previousCommit,
    targetCommit: undefined,
  })
  try {
    await git(['pull', '--ff-only'])
  } catch (err) {
    const message = formatCommandFailure('git pull --ff-only failed', err)
    logger.error({ err }, message)
    status.transition('failed', { error: message, completedAt: nowUtcIso() })
    return {
      success: false,
      previousCommit,
      previousRef,
      newCommit: previousCommit,
      error: message,
    }
  }

  const newCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()

  // Build
  status.transition('building', { targetCommit: newCommit })
  try {
    await runGitBuild(projectRoot)
  } catch (err) {
    const message = formatCommandFailure('Build failed', err)
    logger.error({ err, targetCommit: newCommit }, message)

    const rollback = await rollbackToCheckpoint(projectRoot, status, { previousCommit, previousRef }, message)
    const finalError = rollback.success
      ? message
      : `${message}; rollback failed: ${rollback.error ?? 'unknown rollback error'}`

    status.transition('failed', { error: finalError, completedAt: nowUtcIso() })
    return {
      success: false,
      previousCommit,
      previousRef,
      newCommit: previousCommit,
      error: finalError,
    }
  }

  return { success: true, previousCommit, previousRef, newCommit }
}

// ---------------------------------------------------------------------------
// npm-based update (for `npm install -g night-orch`)
// ---------------------------------------------------------------------------

function readLocalVersion(projectRoot: string): string {
  try {
    const raw = readFileSync(resolve(projectRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version.trim() : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

async function runNpmUpdate(
  projectRoot: string,
  status: UpdateStatusTracker,
): Promise<UpdateResult> {
  const previousVersion = readLocalVersion(projectRoot)

  // Check registry for latest version
  status.transition('pulling', {
    installMethod: 'npm',
    startedAt: nowUtcIso(),
    completedAt: undefined,
    error: undefined,
    previousCommit: previousVersion,
    targetCommit: undefined,
  })

  let latestVersion: string
  try {
    const result = await execa('npm', ['view', 'night-orch', 'version'])
    latestVersion = result.stdout.trim()
  } catch (err) {
    const message = formatCommandFailure('npm view failed', err)
    logger.error({ err }, message)
    status.transition('failed', { error: message, completedAt: nowUtcIso() })
    return {
      success: false,
      previousCommit: previousVersion,
      previousRef: null,
      newCommit: previousVersion,
      error: message,
    }
  }

  if (latestVersion === previousVersion) {
    logger.info({ version: previousVersion }, 'Already at latest version')
    status.transition('idle', { completedAt: nowUtcIso() })
    return {
      success: true,
      previousCommit: previousVersion,
      previousRef: null,
      newCommit: previousVersion,
    }
  }

  // Install the new version
  status.transition('building', { targetCommit: latestVersion })
  try {
    await execa('npm', ['install', '-g', `night-orch@${latestVersion}`])
  } catch (err) {
    const message = formatCommandFailure('npm install -g failed', err)
    logger.error({ err, targetVersion: latestVersion }, message)

    const rollback = await rollbackNpm(status, previousVersion, message)
    const finalError = rollback.success
      ? message
      : `${message}; rollback failed: ${rollback.error ?? 'unknown rollback error'}`

    status.transition('failed', { error: finalError, completedAt: nowUtcIso() })
    return {
      success: false,
      previousCommit: previousVersion,
      previousRef: null,
      newCommit: previousVersion,
      error: finalError,
    }
  }

  return {
    success: true,
    previousCommit: previousVersion,
    previousRef: null,
    newCommit: latestVersion,
  }
}

async function rollbackNpm(
  status: UpdateStatusTracker,
  previousVersion: string,
  reason: string,
): Promise<RollbackResult> {
  status.transition('rolling-back', {
    error: reason,
    targetCommit: previousVersion,
  })

  try {
    await execa('npm', ['install', '-g', `night-orch@${previousVersion}`])
    logger.info({ previousVersion }, 'Rolled back to previous npm version')
    return { success: true }
  } catch (err) {
    const message = formatCommandFailure('npm rollback failed', err)
    logger.error({ err }, message)
    return { success: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Git rollback + build (development installs)
// ---------------------------------------------------------------------------

interface RollbackResult {
  success: boolean
  error?: string
}

const COMMAND_OUTPUT_TAIL = 600

export async function rollbackToCheckpoint(
  projectRoot: string,
  status: UpdateStatusTracker,
  checkpoint: UpdateCheckpoint,
  reason: string,
): Promise<RollbackResult> {
  const mode = detectInstallMode(projectRoot)
  if (mode === 'npm') {
    return rollbackNpm(status, checkpoint.previousCommit, reason)
  }

  const git = (args: string[]) => execa('git', args, { cwd: projectRoot })
  status.transition('rolling-back', {
    error: reason,
    targetCommit: checkpoint.previousCommit,
  })

  try {
    if (checkpoint.previousRef) {
      await git(['checkout', '-B', checkpoint.previousRef, checkpoint.previousCommit])
    } else {
      await git(['checkout', checkpoint.previousCommit])
    }
    await runGitBuild(projectRoot)
    logger.info(
      {
        previousCommit: checkpoint.previousCommit,
        previousRef: checkpoint.previousRef ?? undefined,
      },
      'Rolled back to known-good revision',
    )
    return { success: true }
  } catch (err) {
    const message = formatCommandFailure('Rollback failed', err)
    logger.error({ err }, message)
    return { success: false, error: message }
  }
}

async function runGitBuild(projectRoot: string): Promise<void> {
  await execa('pnpm', ['install', '--frozen-lockfile'], { cwd: projectRoot })
  await execa('pnpm', ['build'], { cwd: projectRoot })
  await execa('pnpm', ['install-global'], { cwd: projectRoot })
}

function formatCommandFailure(prefix: string, err: unknown): string {
  const failure = err as Partial<{
    message: string
    shortMessage: string
    stderr: string
    stdout: string
    exitCode: number
  }>
  const message = failure.shortMessage ?? failure.message ?? String(err)
  const exitCode = typeof failure.exitCode === 'number' ? ` (exit ${failure.exitCode})` : ''

  const tails = [
    summarizeOutputTail('stderr', failure.stderr),
    summarizeOutputTail('stdout', failure.stdout),
  ].filter((value): value is string => value !== null)

  return `${prefix}${exitCode}: ${message}${tails.length > 0 ? ` | ${tails.join(' | ')}` : ''}`
}

function summarizeOutputTail(label: string, output: string | undefined): string | null {
  const trimmed = output?.trim()
  if (!trimmed) {
    return null
  }

  const tail = trimmed
    .slice(-COMMAND_OUTPUT_TAIL)
    .replace(/\s+/g, ' ')

  return `${label}: ${tail}`
}
