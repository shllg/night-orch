import { execa } from 'execa'

export interface DiffStats {
  changedFiles: number
  insertions: number
  deletions: number
  totalChangedLines: number
}

/**
 * Check diff size against configured limits.
 * Runs `git diff --stat` in the worktree.
 */
export async function checkDiffSize(
  worktreePath: string,
  limits: { maxChangedFiles: number; maxChangedLines: number },
  opts: { staged?: boolean } = {},
): Promise<{ ok: boolean; stats: DiffStats; reason: string | null }> {
  const args = opts.staged
    ? ['diff', '--cached', '--stat', '--stat-width=300']
    : ['diff', '--stat', '--stat-width=300', 'HEAD']

  const { stdout } = await execa('git', args, {
    cwd: worktreePath,
    env: {
      ...process.env,
      LC_ALL: 'C',
    },
    reject: false,
  })

  const stats = parseDiffStat(stdout)

  if (stats.changedFiles > limits.maxChangedFiles) {
    return {
      ok: false,
      stats,
      reason: `Too many changed files: ${stats.changedFiles} > ${limits.maxChangedFiles}`,
    }
  }

  if (stats.totalChangedLines > limits.maxChangedLines) {
    return {
      ok: false,
      stats,
      reason: `Too many changed lines: ${stats.totalChangedLines} > ${limits.maxChangedLines}`,
    }
  }

  return { ok: true, stats, reason: null }
}

function parseDiffStat(output: string): DiffStats {
  const lines = output.trim().split('\n')
  if (lines.length === 0 || output.trim() === '') {
    return { changedFiles: 0, insertions: 0, deletions: 0, totalChangedLines: 0 }
  }

  // Last line is the summary: "3 files changed, 10 insertions(+), 2 deletions(-)"
  const summary = lines[lines.length - 1] ?? ''
  const filesMatch = summary.match(/(\d+)\s+files?\s+changed/)
  const insertMatch = summary.match(/(\d+)\s+insertions?\(\+\)/)
  const deleteMatch = summary.match(/(\d+)\s+deletions?\(-\)/)

  const changedFiles = filesMatch ? parseInt(filesMatch[1]!, 10) : 0
  const insertions = insertMatch ? parseInt(insertMatch[1]!, 10) : 0
  const deletions = deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0

  return {
    changedFiles,
    insertions,
    deletions,
    totalChangedLines: insertions + deletions,
  }
}
