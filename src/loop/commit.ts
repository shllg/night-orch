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

  // Diff-size guard
  const diffCheck = await checkDiffSize(worktreePath, securityConfig)
  if (!diffCheck.ok) {
    logger.warn(
      { stats: diffCheck.stats, reason: diffCheck.reason },
      'Diff-size guard triggered — skipping commit',
    )
    return { committed: false, reason: `Diff-size guard: ${diffCheck.reason}` }
  }

  // Stage and commit
  await execa('git', ['add', '-A'], { cwd: worktreePath })
  const message = `night-orch: implement #${issueNumber} ${issueTitle}`
  await execa('git', ['commit', '-m', message], { cwd: worktreePath })

  logger.info(
    { issueNumber, files: diffCheck.stats.changedFiles, lines: diffCheck.stats.totalChangedLines },
    'Changes committed',
  )

  return { committed: true, reason: null }
}
