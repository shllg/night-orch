import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import { nowUtcIso } from '../utils/time.js'
import type { UpdateStatusTracker } from './status.js'

export interface UpdateCheckpoint {
  previousCommit: string
  previousRef: string | null
}

export interface UpdateResult extends UpdateCheckpoint {
  success: boolean
  newCommit: string
  error?: string
}

export async function runUpdate(
  projectRoot: string,
  status: UpdateStatusTracker,
): Promise<UpdateResult> {
  const git = (args: string[]) => execa('git', args, { cwd: projectRoot })
  const previousCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const previousRefRaw = (await git(['branch', '--show-current'])).stdout.trim()
  const previousRef = previousRefRaw.length > 0 ? previousRefRaw : null

  // Pull
  status.transition('pulling', {
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
    await runBuild(projectRoot)
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
    await runBuild(projectRoot)
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

async function runBuild(projectRoot: string): Promise<void> {
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
