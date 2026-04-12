import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit } from '../git/process.js'
import { mergeFromBranch } from '../git/repo.js'
import { logger } from '../utils/logger.js'
import type { UpdateStrategy } from '../git/worktree.js'

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
  error?: string
}

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
          log.warn({ baseBranch }, 'Rebase conflict — collecting conflict analysis before abort')
          const conflictAnalysis = await collectConflictAnalysis(worktreePath, baseBranch)
          try {
            await runGit(['rebase', '--abort'], { cwd: worktreePath, timeout: 30_000 })
          } catch {
            log.error('Failed to abort rebase')
          }
          return { result: 'conflict', conflictAnalysis }
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

async function readConflictPreview(worktreePath: string, filePath: string): Promise<string> {
  try {
    const raw = await readFile(join(worktreePath, filePath), 'utf-8')
    return truncateConflictText(raw)
  } catch {
    return ''
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
