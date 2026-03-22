import { execa } from 'execa'
import { checkDiffSize } from './diff-guard.js'
import type { Config } from '../config/schema.js'
import { logger } from '../utils/logger.js'

/**
 * Stage all changes and commit with a standard message.
 * Runs diff-guard before committing.
 */
export async function commitChanges(
  worktreePath: string,
  issueNumber: number,
  issueTitle: string,
  securityConfig: Config['security'],
): Promise<{ committed: boolean; reason: string | null }> {
  // Check if there are any changes to commit
  const { stdout: statusOutput } = await execa('git', ['status', '--porcelain'], {
    cwd: worktreePath,
  })
  if (statusOutput.trim() === '') {
    return { committed: false, reason: 'No changes to commit' }
  }

  // Stage before diff-size guard so new files are included in checks.
  await execa('git', ['add', '-A'], { cwd: worktreePath })

  // Diff-size guard on staged changes.
  const diffCheck = await checkDiffSize(worktreePath, securityConfig, { staged: true })
  if (!diffCheck.ok) {
    await execa('git', ['reset', 'HEAD', '--', '.'], { cwd: worktreePath, reject: false })
    logger.warn(
      { stats: diffCheck.stats, reason: diffCheck.reason },
      'Diff-size guard triggered — skipping commit',
    )
    return { committed: false, reason: `Diff-size guard: ${diffCheck.reason}` }
  }

  const message = `night-orch: implement #${issueNumber} ${sanitizeCommitTitle(issueTitle)}`
  await execa('git', ['commit', '-m', message], { cwd: worktreePath })

  logger.info(
    { issueNumber, files: diffCheck.stats.changedFiles, lines: diffCheck.stats.totalChangedLines },
    'Changes committed',
  )

  return { committed: true, reason: null }
}

function sanitizeCommitTitle(title: string): string {
  return title
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[^\w\s.,:;!?()[\]{}\-/#]/g, '')
    .trim()
}
