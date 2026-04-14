import type { UpdateStrategy } from '../git/worktree.js'
import { runGit } from '../git/process.js'
import { logger } from '../utils/logger.js'

export class MergeConflictError extends Error {
  readonly code = 'MERGE_CONFLICT' as const
  constructor(branchName: string, detail: string) {
    super(`Push failed for ${branchName} due to merge conflicts: ${detail}`)
  }
}

/**
 * Push a branch to origin using --force-with-lease to prevent overwriting
 * commits pushed by others (e.g., reviewer-pushed fixes).
 * On rejection (branch diverged), attempts a single branch reconciliation
 * using the configured strategy and then retries the push.
 *
 * @throws {MergeConflictError} when branch reconciliation after rejected push encounters conflicts.
 */
export async function pushBranch(
  worktreePath: string,
  branchName: string,
  strategy: UpdateStrategy = 'merge',
): Promise<void> {
  logger.info({ branchName }, 'Pushing branch to remote')
  try {
    await runGit(['push', '--force-with-lease', '-u', 'origin', branchName], {
      cwd: worktreePath,
      timeout: 60_000,
    })
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err)

    // Detect rejected push (branch diverged or lease failed)
    if (stderr.includes('rejected') || stderr.includes('non-fast-forward') || stderr.includes('stale info')) {
      logger.warn({ branchName, strategy }, 'Push rejected — attempting branch reconciliation')
      try {
        await runGit(['fetch', 'origin', branchName], { cwd: worktreePath, timeout: 60_000 })
        if (strategy === 'rebase') {
          await runGit(['rebase', `origin/${branchName}`], {
            cwd: worktreePath,
            timeout: 60_000,
          })
        } else {
          await runGit(['merge', `origin/${branchName}`, '--no-edit'], {
            cwd: worktreePath,
            timeout: 60_000,
          })
        }
        await runGit(['push', '--force-with-lease', '-u', 'origin', branchName], {
          cwd: worktreePath,
          timeout: 60_000,
        })
        return
      } catch (reconcileErr: unknown) {
        const reconcileStderr = (reconcileErr as { stderr?: string }).stderr ?? String(reconcileErr)
        if (isConflictText(reconcileStderr)) {
          // Abort the failed reconciliation to leave worktree in a clean state.
          try {
            await runGit([strategy === 'rebase' ? 'rebase' : 'merge', '--abort'], { cwd: worktreePath, timeout: 30_000 })
          } catch { /* best-effort abort */ }
          throw new MergeConflictError(branchName, reconcileStderr)
        }
        throw new Error(`Push failed for ${branchName} after ${strategy} reconciliation attempt: ${reconcileStderr}`)
      }
    }

    throw new Error(`Push failed for ${branchName}: ${stderr}`)
  }
}

function isConflictText(detail: string): boolean {
  return detail.includes('CONFLICT')
    || detail.includes('could not apply')
    || detail.includes('Automatic merge failed')
}
