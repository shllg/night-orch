import { checkDiffSize } from './diff-guard.js'
import type { Config } from '../config/schema.js'
import { logger } from '../utils/logger.js'
import { normalizeRepoRelativePath } from '../planning/mode.js'
import { runGit } from '../git/process.js'

export interface CommitChangesOptions {
  planningOnlyPrdPath?: string
}

export interface CommitChangesResult {
  committed: boolean
  reason: string | null
  /** If true, caller should end the run as blocked instead of publishing. */
  blockRun: boolean
}

/**
 * Stage all changes and commit with a standard message.
 * Runs diff-guard before committing.
 */
export async function commitChanges(
  worktreePath: string,
  issueNumber: number,
  issueTitle: string,
  securityConfig: Config['security'],
  opts: CommitChangesOptions = {},
): Promise<CommitChangesResult> {
  const expectedPlanningPath = opts.planningOnlyPrdPath
    ? normalizeGitPath(opts.planningOnlyPrdPath)
    : null

  // Check if there are any changes to commit
  const { stdout: statusOutput } = await runGit(['status', '--porcelain'], {
    cwd: worktreePath,
  })
  if (statusOutput.trim() === '') {
    if (expectedPlanningPath) {
      return {
        committed: false,
        reason: `Planning-only guard: expected "${expectedPlanningPath}" but no changes were found`,
        blockRun: true,
      }
    }
    return { committed: false, reason: 'No changes to commit', blockRun: false }
  }

  // Stage before diff-size guard so new files are included in checks.
  await runGit(['add', '-A'], { cwd: worktreePath })

  // Diff-size guard on staged changes.
  const diffCheck = await checkDiffSize(worktreePath, securityConfig, { staged: true })
  if (!diffCheck.ok) {
    await runGit(['reset', 'HEAD', '--', '.'], { cwd: worktreePath, reject: false })
    logger.warn(
      { stats: diffCheck.stats, reason: diffCheck.reason },
      'Diff-size guard triggered — skipping commit',
    )
    return { committed: false, reason: `Diff-size guard: ${diffCheck.reason}`, blockRun: true }
  }

  if (expectedPlanningPath) {
    const changedFiles = await getStagedChangedFiles(worktreePath)
    const normalizedFiles = changedFiles.map(normalizeGitPath)
    const isOnlyExpected = normalizedFiles.length === 1 && normalizedFiles[0] === expectedPlanningPath

    if (!isOnlyExpected) {
      await runGit(['reset', 'HEAD', '--', '.'], { cwd: worktreePath, reject: false })
      return {
        committed: false,
        reason: `Planning-only guard: expected only "${expectedPlanningPath}" but found [${normalizedFiles.join(', ') || '(none)'}]`,
        blockRun: true,
      }
    }
  }

  const message = `night-orch: implement #${issueNumber} ${sanitizeCommitTitle(issueTitle)}`
  await runGit(['commit', '-m', message], { cwd: worktreePath })

  logger.info(
    { issueNumber, files: diffCheck.stats.changedFiles, lines: diffCheck.stats.totalChangedLines },
    'Changes committed',
  )

  return { committed: true, reason: null, blockRun: false }
}

function sanitizeCommitTitle(title: string): string {
  return title
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[^\w\s.,:;!?()[\]{}\-/#]/g, '')
    .trim()
}

function normalizeGitPath(path: string): string {
  return normalizeRepoRelativePath(path).replace(/^\/+/, '')
}

async function getStagedChangedFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await runGit(['diff', '--cached', '--name-only'], { cwd: worktreePath })
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
