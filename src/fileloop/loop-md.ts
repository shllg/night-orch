import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function appendLoopNote(
  worktreePath: string,
  relativePath: string,
  filePath: string,
  note: string,
): Promise<void> {
  const trimmed = note.trim()
  if (trimmed.length === 0) return

  const targetPath = join(worktreePath, relativePath)
  const entry = [
    `## ${filePath}`,
    `<!-- file-loop note: ${escapeComment(trimmed)} -->`,
    '',
  ].join('\n')

  await appendFile(targetPath, entry, 'utf8')
}

export async function tailLoopMd(
  worktreePath: string,
  relativePath: string,
  bytes = 4096,
): Promise<string> {
  const targetPath = join(worktreePath, relativePath)
  try {
    const content = await readFile(targetPath, 'utf8')
    return content.slice(Math.max(0, content.length - bytes))
  } catch {
    return ''
  }
}

export async function topLoopEntries(
  worktreePath: string,
  relativePath: string,
  limit = 5,
): Promise<Array<{ filePath: string; note: string }>> {
  const targetPath = join(worktreePath, relativePath)
  try {
    const content = await readFile(targetPath, 'utf8')
    return parseLoopEntries(content).slice(0, limit)
  } catch {
    return []
  }
}

export function parseLoopEntries(content: string): Array<{ filePath: string; note: string }> {
  const lines = content.split('\n')
  const entries: Array<{ filePath: string; note: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i]
    if (!heading?.startsWith('## ')) continue
    const filePath = heading.slice(3).trim()
    const commentLine = lines[i + 1] ?? ''
    const match = commentLine.match(/^<!-- file-loop note: ([\s\S]*) -->$/)
    if (!match?.[1]) continue
    entries.push({ filePath, note: unescapeComment(match[1]) })
  }

  return entries
}

function escapeComment(value: string): string {
  return value.replace(/-->/g, '--&gt;').replace(/\r?\n/g, ' ')
}

function unescapeComment(value: string): string {
  return value.replace(/--&gt;/g, '-->')
}
