import { execa } from 'execa'
import { checkDiffSize } from './diff-guard.js'
import type { Config } from '../config/schema.js'
import { logger } from '../utils/logger.js'

export interface CommitModeOptions {
  planningOutputDir?: string
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
  options: CommitModeOptions = {},
): Promise<{ committed: boolean; reason: string | null }> {
  // Check if there are any changes to commit
  const { stdout: statusOutput } = await execa('git', ['status', '--porcelain'], {
    cwd: worktreePath,
  })
  if (statusOutput.trim() === '') {
    return { committed: false, reason: 'No changes to commit' }
  }

  if (options.planningOutputDir) {
    const changedFiles = parsePorcelainChangedFiles(statusOutput)
    const validation = validatePlanningOutput(changedFiles, options.planningOutputDir)
    if (!validation.ok) {
      logger.warn({ worktreePath, changedFiles, outputDir: options.planningOutputDir, reason: validation.reason }, 'Planning-mode commit guard blocked commit')
      return { committed: false, reason: `Planning guard: ${validation.reason}` }
    }
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

function parsePorcelainChangedFiles(statusOutput: string): string[] {
  const files = new Set<string>()
  for (const line of statusOutput.split('\n')) {
    if (line.trim().length === 0) continue
    const rawPath = line.slice(3).trim()
    const path = rawPath.includes(' -> ')
      ? rawPath.split(' -> ').pop() ?? ''
      : rawPath
    const normalized = normalizeRepoRelativePath(path)
    if (normalized.length > 0) files.add(normalized)
  }
  return [...files]
}

function validatePlanningOutput(
  changedFiles: string[],
  outputDir: string,
): { ok: true } | { ok: false; reason: string } {
  if (changedFiles.length !== 1) {
    return {
      ok: false,
      reason: `planning mode requires exactly 1 changed file, found ${changedFiles.length}`,
    }
  }

  const targetFile = changedFiles[0]!
  if (!targetFile.toLowerCase().endsWith('.md')) {
    return {
      ok: false,
      reason: `planning mode requires a markdown file, found "${targetFile}"`,
    }
  }

  const normalizedDir = normalizeRepoRelativePath(outputDir)
  if (normalizedDir.length === 0) {
    return { ok: false, reason: 'planning outputDir must not be empty' }
  }

  const expectedPrefix = `${normalizedDir}/`
  if (!targetFile.startsWith(expectedPrefix)) {
    return {
      ok: false,
      reason: `planning file must be under "${normalizedDir}/", found "${targetFile}"`,
    }
  }

  return { ok: true }
}

function normalizeRepoRelativePath(value: string): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}
