import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { runGit } from '../git/process.js'
import type { FileLoopConfig } from '../config/schema.js'
import type { PickedCandidate } from './types.js'
import type { FileLoopFileStateStore } from './file-state.js'

export interface PickerDependencies {
  listTrackedFiles?: (worktreePath: string) => Promise<string[]>
  getLineCount?: (absolutePath: string) => Promise<number>
  isBinaryFile?: (worktreePath: string, filePath: string) => Promise<boolean>
  random?: () => number
}

interface RankedCandidate {
  filePath: string
  lastTouchedAt: string | null
  lineCount: number
}

export async function pickNext(
  repo: string,
  worktreePath: string,
  config: FileLoopConfig,
  fileStateStore: FileLoopFileStateStore,
  deps: PickerDependencies = {},
): Promise<PickedCandidate | null> {
  const listTrackedFiles = deps.listTrackedFiles ?? defaultListTrackedFiles
  const getLineCount = deps.getLineCount ?? defaultLineCount
  const isBinaryFile = deps.isBinaryFile ?? defaultIsBinaryFile
  const random = deps.random ?? Math.random
  const matcher = buildMatcher(config.includeGlobs, config.excludeGlobs)

  const states = new Map(fileStateStore.listForRepo(repo).map((state) => [state.filePath, state]))
  const files = await listTrackedFiles(worktreePath)
  const ranked: RankedCandidate[] = []

  for (const filePath of files) {
    if (!matcher(filePath)) continue
    if (await isBinaryFile(worktreePath, filePath)) continue

    const lineCount = await getLineCount(join(worktreePath, filePath))
    if (lineCount === 0 || lineCount > config.maxFileLines) continue

    ranked.push({
      filePath,
      lineCount,
      lastTouchedAt: states.get(filePath)?.lastTouchedAt ?? null,
    })
  }

  if (ranked.length === 0) return null

  ranked.sort((a, b) => compareCandidates(a, b, random))
  const candidate = ranked[0]
  if (!candidate) return null

  return {
    filePath: candidate.filePath,
    lineCount: candidate.lineCount,
    lastTouchedAt: candidate.lastTouchedAt,
  }
}

export function compareCandidates(
  left: RankedCandidate,
  right: RankedCandidate,
  random: () => number,
): number {
  if (left.lastTouchedAt === null && right.lastTouchedAt !== null) return -1
  if (left.lastTouchedAt !== null && right.lastTouchedAt === null) return 1
  if (left.lastTouchedAt && right.lastTouchedAt && left.lastTouchedAt !== right.lastTouchedAt) {
    return left.lastTouchedAt.localeCompare(right.lastTouchedAt)
  }
  if (left.filePath === right.filePath) return 0
  return random() < 0.5 ? -1 : 1
}

function buildMatcher(includeGlobs: string[], excludeGlobs: string[]): (filePath: string) => boolean {
  const include = includeGlobs.map(globToRegExp)
  const exclude = excludeGlobs.map(globToRegExp)
  return (filePath: string) => include.some((matcher) => matcher(filePath)) && !exclude.some((matcher) => matcher(filePath))
}

function globToRegExp(pattern: string): (filePath: string) => boolean {
  const normalized = expandBraces(pattern)
  const source = `^(?:${normalized.map(convertSinglePattern).join('|')})$`
  const regex = new RegExp(source)
  return (filePath: string) => regex.test(filePath)
}

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^}]+)\}/)
  if (match?.index === undefined) return [pattern]

  const whole = match[0]
  const inner = match[1]
  if (!whole || !inner) return [pattern]
  const prefix = pattern.slice(0, match.index)
  const suffix = pattern.slice(match.index + whole.length)
  return inner.split(',').flatMap((part) => expandBraces(`${prefix}${part}${suffix}`))
}

function convertSinglePattern(pattern: string): string {
  let regex = ''

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    const next = pattern[i + 1]

    if (char === '*' && next === '*') {
      const nextNext = pattern[i + 2]
      if (nextNext === '/') {
        regex += '(?:.*/)?'
        i += 2
      } else {
        regex += '.*'
        i += 1
      }
      continue
    }

    if (char === '*') {
      regex += '[^/]*'
      continue
    }

    if (char === '?') {
      regex += '[^/]'
      continue
    }

    regex += escapeRegex(char ?? '')
  }

  return regex
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

async function defaultListTrackedFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await runGit(['ls-files', '-z'], { cwd: worktreePath })
  return stdout.split('\0').map((line) => line.trim()).filter(Boolean)
}

async function defaultLineCount(filePath: string): Promise<number> {
  const content = await readFile(filePath, 'utf8')
  if (content.length === 0) return 0
  return content.split('\n').length
}

async function defaultIsBinaryFile(worktreePath: string, filePath: string): Promise<boolean> {
  const { stdout } = await runGit(['check-attr', 'binary', '--', filePath], { cwd: worktreePath })
  return stdout.includes(': binary: set')
}
