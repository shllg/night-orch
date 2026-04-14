import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit } from '../git/process.js'
import { mergeFromBranch } from '../git/repo.js'
import { logger } from '../utils/logger.js'
import type { UpdateStrategy } from '../git/worktree.js'
import type { MetricsService } from '../metrics/service.js'
import { validateConflictResolution } from './conflict-resolver-validate.js'
import type {
  ConflictResolutionContext,
  ConflictResolutionMetadata,
  ConflictResolver,
  FullConflictSource,
} from './conflict-types.js'

export interface RebaseTarget {
  repo: string
  issueNumber: number
  prNumber: number
  branchName: string
  baseBranch: string
  worktreePath: string
}

export type RebaseResult = 'up_to_date' | 'rebased' | 'conflict' | 'error'

export interface RebaseConflictExcerpt {
  path: string
  preview: string
  base?: string
  ours?: string
  theirs?: string
}

export interface RebaseConflictAnalysis {
  files: string[]
  summary: string
  excerpts: RebaseConflictExcerpt[]
}

export interface AutoRebaseResult {
  result: RebaseResult
  conflictAnalysis?: RebaseConflictAnalysis
  resolution?: ConflictResolutionMetadata
  error?: string
}

export interface AutoRebaseOptions {
  resolver?: ConflictResolver
  context?: ConflictResolutionContext
  metrics?: MetricsService
}

type RebaseLogger = Pick<typeof logger, 'info' | 'warn' | 'error'>
const MAX_CONFLICT_SOURCE_CHARS = 200_000

/**
 * Update a branch to incorporate latest base branch changes and push.
 * Supports both merge and rebase strategies. Uses --force-with-lease for
 * push to protect against overwriting others' work.
 *
 * @param strategy - 'merge' creates a merge commit (reliable), 'rebase' replays commits (linear history)
 * @returns 'up_to_date' if no update needed, 'rebased' on success,
 *          'conflict' if update had conflicts (aborted), 'error' on other failures.
 */
export async function autoRebase(
  target: RebaseTarget,
  repoLocalPath: string,
  strategy: UpdateStrategy = 'merge',
  options: AutoRebaseOptions = {},
): Promise<AutoRebaseResult> {
  const { branchName, baseBranch, worktreePath } = target
  const log = logger.child({ repo: target.repo, issue: target.issueNumber, branch: branchName })

  try {
    // Fetch latest remote state
    await runGit(['fetch', 'origin'], {
      cwd: repoLocalPath,
      timeout: 60_000,
    })

    // Check if base branch is already an ancestor of HEAD (i.e., no update needed)
    try {
      await runGit(['merge-base', '--is-ancestor', `origin/${baseBranch}`, 'HEAD'], {
        cwd: worktreePath,
        timeout: 30_000,
      })
      return { result: 'up_to_date' }
    } catch {
      // Non-zero exit = base is NOT an ancestor → update needed
    }

    const remoteRef = `origin/${baseBranch}`
    log.info({ baseBranch, strategy }, 'Base branch has moved ahead — updating')

    if (strategy === 'merge') {
      const result = await mergeFromBranch(worktreePath, remoteRef)
      if (!result.success) {
        if (result.conflict) {
          log.warn({ baseBranch }, 'Merge conflict with base branch — aborting')
          return { result: 'conflict' }
        }
        return { result: 'error' }
      }
    } else {
      // Rebase strategy
      try {
        await runGit(['rebase', remoteRef], {
          cwd: worktreePath,
          timeout: 120_000,
        })
      } catch (rebaseErr) {
        const stderr = (rebaseErr as { stderr?: string }).stderr ?? ''
        if (stderr.includes('CONFLICT') || stderr.includes('could not apply')) {
          options.metrics?.incRebaseConflict()
          log.warn({ baseBranch }, 'Rebase conflict — collecting conflict analysis before abort')
          let conflictAnalysis = await collectConflictAnalysis(worktreePath, baseBranch)
          const resolution = await attemptConflictResolution(target, worktreePath, options, log)

          if (resolution?.outcome === 'resolved') {
            options.metrics?.incRebaseAutoResolved()
            return { result: 'rebased', resolution }
          }

          if (resolution?.attempted) {
            options.metrics?.incRebaseAutoResolveFailed(resolution.outcome)
            conflictAnalysis = await collectConflictAnalysis(worktreePath, baseBranch)
          }

          try {
            await runGit(['rebase', '--abort'], { cwd: worktreePath, timeout: 30_000 })
          } catch {
            log.error('Failed to abort rebase')
          }
          return {
            result: 'conflict',
            conflictAnalysis,
            resolution: resolution ?? { attempted: false, outcome: 'unresolved' },
          }
        }
        throw rebaseErr
      }
    }

    // Push with --force-with-lease
    await runGit(['push', '--force-with-lease', 'origin', branchName], {
      cwd: worktreePath,
      timeout: 60_000,
    })

    log.info({ baseBranch, strategy }, 'Updated and pushed successfully')
    return { result: 'rebased' }
  } catch (err) {
    log.error({ err }, 'Auto-update failed')
    return { result: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

async function attemptConflictResolution(
  target: RebaseTarget,
  worktreePath: string,
  options: AutoRebaseOptions,
  log: RebaseLogger,
): Promise<ConflictResolutionMetadata | undefined> {
  if (!options.resolver || !options.context) {
    return undefined
  }

  for (let attempt = 1; attempt <= options.resolver.maxAttempts; attempt++) {
    const sourceResult = await collectFullConflictSources(worktreePath)
    if (sourceResult.skip) {
      log.warn(
        {
          attempt,
          path: sourceResult.skip.path,
          reason: sourceResult.skip.reason,
        },
        'Skipping conflict auto-resolution for an ineligible conflicted file',
      )
      return {
        attempted: true,
        outcome: 'unresolved',
      }
    }

    const sources = sourceResult.sources
    if (sources.length === 0) {
      return {
        attempted: true,
        outcome: 'unresolved',
      }
    }

    let resolution
    try {
      resolution = await options.resolver.resolveConflicts(sources, options.context, {
        repo: target.repo,
        issueNumber: target.issueNumber,
        attempt,
      })
    } catch (err) {
      log.warn({ attempt, err }, 'Conflict resolver threw before returning a result')
      return {
        attempted: true,
        outcome: 'error',
      }
    }

    if (!resolution.ok) {
      return {
        attempted: true,
        outcome: resolution.outcome,
        files: resolution.files,
      }
    }

    const validationFailure = findValidationFailure(sources, resolution.files)
    if (validationFailure) {
      log.warn(
        {
          attempt,
          path: validationFailure.path,
          reason: validationFailure.reason,
        },
        'Conflict resolver output failed validation',
      )
      return {
        attempted: true,
        outcome: 'validation_failed',
        files: resolution.files.map((file) => file.path),
      }
    }

    await writeResolvedFiles(worktreePath, resolution.files)
    await stageResolvedFiles(worktreePath, resolution.files.map((file) => file.path))

    try {
      await runGit(['rebase', '--continue'], {
        cwd: worktreePath,
        timeout: 120_000,
        env: { GIT_EDITOR: 'true' },
      })
      log.info(
        {
          attempt,
          files: resolution.files.map((file) => file.path),
        },
        'Conflict resolver completed the rebase',
      )
      return {
        attempted: true,
        outcome: 'resolved',
        files: resolution.files.map((file) => file.path),
      }
    } catch (continueErr) {
      const stderr = (continueErr as { stderr?: string }).stderr ?? ''
      if (!stderr.includes('CONFLICT') && !stderr.includes('could not apply')) {
        log.warn({ attempt, err: continueErr }, 'git rebase --continue failed after resolver write')
        return {
          attempted: true,
          outcome: 'error',
          files: resolution.files.map((file) => file.path),
        }
      }

      log.info({ attempt }, 'Resolver advanced the rebase but more conflicts remain')
    }
  }

  return {
    attempted: true,
    outcome: 'unresolved',
  }
}

function findValidationFailure(
  sources: FullConflictSource[],
  files: Array<{ path: string; resolved: string }>,
): { path: string; reason: string } | null {
  const sourceByPath = new Map(sources.map((source) => [source.path, source]))
  for (const file of files) {
    const source = sourceByPath.get(file.path)
    if (!source) {
      return { path: file.path, reason: 'missing conflict source for resolved file' }
    }
    const validation = validateConflictResolution(source, file.resolved)
    if (!validation.valid) {
      return {
        path: file.path,
        reason: validation.reason ?? 'validation failed',
      }
    }
  }
  return null
}

export function classifyConflictFileBuffer(
  buffer: Buffer | null,
): 'unreadable' | 'binary' | 'oversized' | null {
  if (buffer === null) return 'unreadable'
  if (buffer.includes(0)) return 'binary'
  if (buffer.byteLength > MAX_CONFLICT_SOURCE_CHARS) return 'oversized'
  return null
}

export function findConflictSourceIneligibility(
  source: FullConflictSource,
): { path: string; reason: 'binary' | 'oversized' } | null {
  const fields = [
    source.mergedWithMarkers,
    source.base,
    source.ours,
    source.theirs,
  ]
  for (const field of fields) {
    if (field.includes('\0')) {
      return { path: source.path, reason: 'binary' }
    }
    if (field.length > MAX_CONFLICT_SOURCE_CHARS) {
      return { path: source.path, reason: 'oversized' }
    }
  }
  return null
}

async function collectConflictAnalysis(
  worktreePath: string,
  baseBranch: string,
): Promise<RebaseConflictAnalysis> {
  const files = await listUnmergedFiles(worktreePath)
  const excerpts: RebaseConflictExcerpt[] = []

  for (const filePath of files.slice(0, 5)) {
    excerpts.push({
      path: filePath,
      preview: await readConflictPreview(worktreePath, filePath),
      base: await readConflictStage(worktreePath, 1, filePath),
      ours: await readConflictStage(worktreePath, 2, filePath),
      theirs: await readConflictStage(worktreePath, 3, filePath),
    })
  }

  return {
    files,
    summary: formatConflictSummary(baseBranch, files),
    excerpts,
  }
}

async function listUnmergedFiles(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: worktreePath })
    return stdout.split('\n').map((value) => value.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export async function collectFullConflictSources(
  worktreePath: string,
): Promise<{
  sources: FullConflictSource[]
  skip?: { path: string; reason: 'unreadable' | 'binary' | 'oversized' }
}> {
  const files = await listUnmergedFiles(worktreePath)
  const sources: FullConflictSource[] = []

  for (const filePath of files) {
    const mergedBuffer = await readConflictFileBuffer(worktreePath, filePath)
    if (!mergedBuffer) {
      return {
        sources,
        skip: {
          path: filePath,
          reason: 'unreadable',
        },
      }
    }
    const mergedStatus = classifyConflictFileBuffer(mergedBuffer)
    if (mergedStatus) {
      return {
        sources,
        skip: {
          path: filePath,
          reason: mergedStatus,
        },
      }
    }

    const source = {
      path: filePath,
      mergedWithMarkers: mergedBuffer.toString('utf-8'),
      base: await readConflictStageRaw(worktreePath, 1, filePath),
      ours: await readConflictStageRaw(worktreePath, 2, filePath),
      theirs: await readConflictStageRaw(worktreePath, 3, filePath),
    }
    const sourceStatus = findConflictSourceIneligibility(source)
    if (sourceStatus) {
      return {
        sources,
        skip: sourceStatus,
      }
    }
    sources.push(source)
  }

  return { sources }
}

async function readConflictPreview(worktreePath: string, filePath: string): Promise<string> {
  try {
    const raw = await readFile(join(worktreePath, filePath), 'utf-8')
    return truncateConflictText(raw)
  } catch {
    return ''
  }
}

async function readConflictFileBuffer(worktreePath: string, filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(join(worktreePath, filePath))
  } catch {
    return null
  }
}

async function readConflictStage(
  worktreePath: string,
  stage: 1 | 2 | 3,
  filePath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['show', `:${stage}:${filePath}`], {
      cwd: worktreePath,
      reject: false,
    })
    const trimmed = stdout.trim()
    return trimmed ? truncateConflictText(trimmed) : undefined
  } catch {
    return undefined
  }
}

async function readConflictStageRaw(
  worktreePath: string,
  stage: 1 | 2 | 3,
  filePath: string,
): Promise<string> {
  try {
    const { stdout } = await runGit(['show', `:${stage}:${filePath}`], {
      cwd: worktreePath,
      reject: false,
    })
    return stdout
  } catch {
    return ''
  }
}

async function writeResolvedFiles(
  worktreePath: string,
  files: Array<{ path: string; resolved: string }>,
): Promise<void> {
  for (const file of files) {
    await writeFile(join(worktreePath, file.path), file.resolved, 'utf-8')
  }
}

async function stageResolvedFiles(worktreePath: string, filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) return
  await runGit(['add', '--', ...filePaths], {
    cwd: worktreePath,
    timeout: 30_000,
  })
}

function truncateConflictText(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 1200) return trimmed
  return `${trimmed.slice(0, 1200)}\n[... truncated ...]`
}

function formatConflictSummary(baseBranch: string, files: string[]): string {
  const listedFiles = files.slice(0, 5)
  const fileSummary = listedFiles.length > 0 ? `: ${listedFiles.join(', ')}` : ''
  return [
    `Rebase onto origin/${baseBranch} hit conflicts in ${files.length} file(s)${fileSummary}.`,
    'Options: (a) resolve manually and continue, (b) continue with merge strategy, (c) abort and re-open the issue.',
  ].join(' ')
}
