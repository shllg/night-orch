import { runGit } from '../git/process.js'

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

  const { stdout } = await runGit(args, {
    cwd: worktreePath,
    env: { LC_ALL: 'C' },
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

/**
 * Early scope guard: check the coder's working-tree changes against the
 * size limits *before* spending verify + review on an over-scoped diff.
 *
 * Unlike `checkDiffSize` (which the commit path runs on the staged
 * index), this runs mid-loop when nothing is staged yet, so it first
 * marks new files intent-to-add (`git add -N`) — a reversible, no-content
 * operation — so untracked files count toward the diff. This catches the
 * "157 changed files > 50" scope explosions at the code phase instead of
 * only at commit time.
 */
export async function checkWorktreeScope(
  worktreePath: string,
  limits: { maxChangedFiles: number; maxChangedLines: number },
): Promise<{ ok: boolean; stats: DiffStats; reason: string | null }> {
  // Intent-to-add untracked files so `git diff` accounts for them.
  // Reversible (no content staged); the commit path later runs `git add -A`.
  await runGit(['add', '-A', '--intent-to-add'], { cwd: worktreePath, reject: false })
  return checkDiffSize(worktreePath, limits, { staged: false })
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
