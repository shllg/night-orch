import type { ForgeComment } from '../forge/types.js'
import type Database from 'better-sqlite3'
import { parseUtcTimestampMs } from '../utils/time.js'

export type OrchCommand =
  | { type: 'retry'; resetPlan: boolean }
  | { type: 'rebase'; checkAfter: boolean }
  | { type: 'continue' }
  | { type: 'cancel' }

export interface ParsedCommand {
  commentId: number
  command: OrchCommand
  user: string
}

const COMMAND_PATTERN = /^\s*\/(?:orch|night-orch)\s+(\S+)(?:\s+(.*))?$/im

/**
 * Strip code fences from text so commands inside them are ignored.
 * Replaces the content of ```...``` blocks with empty strings.
 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '')
}

/**
 * Parse a single command string into an OrchCommand.
 * Returns undefined if the command is not recognized.
 */
function parseCommand(verb: string, args: string | undefined): OrchCommand | undefined {
  switch (verb.toLowerCase()) {
    case 'retry':
      return { type: 'retry', resetPlan: args?.includes('--reset-plan') ?? false }
    case 'rebase':
      return { type: 'rebase', checkAfter: args?.includes('--check') ?? true }
    case 'continue':
      return { type: 'continue' }
    case 'cancel':
      return { type: 'cancel' }
    default:
      return undefined
  }
}

/**
 * Parse `/orch` or `/night-orch` commands from issue/PR comments.
 * Only considers comments newer than sinceTimestamp.
 * Ignores commands inside code blocks.
 */
export function parseOrchCommands(
  comments: ForgeComment[],
  sinceTimestamp: string,
): ParsedCommand[] {
  const since = parseUtcTimestampMs(sinceTimestamp)
  if (!Number.isFinite(since)) return []
  const results: ParsedCommand[] = []

  for (const comment of comments) {
    const commentTime = parseUtcTimestampMs(comment.createdAt)
    if (!Number.isFinite(commentTime) || commentTime <= since) continue

    const cleaned = stripCodeBlocks(comment.body)
    const match = COMMAND_PATTERN.exec(cleaned)
    if (!match) continue

    const verb = match[1]
    const args = match[2]
    if (!verb) continue

    const command = parseCommand(verb, args)
    if (!command) continue

    results.push({
      commentId: comment.id,
      command,
      user: comment.user,
    })
  }

  return results
}

/**
 * Check if a command has already been processed.
 */
export function isCommandProcessed(
  db: Database.Database,
  repo: string,
  issueNumber: number,
  commentId: number,
): boolean {
  const row = db
    .prepare('SELECT 1 FROM command_tracking WHERE repo = ? AND issue_number = ? AND comment_id = ?')
    .get(repo, issueNumber, commentId) as { '1': number } | undefined
  return row !== undefined
}

/**
 * Mark a command as processed.
 */
export function markCommandProcessed(
  db: Database.Database,
  repo: string,
  issueNumber: number,
  commentId: number,
  command: string,
): void {
  db.prepare(
    'INSERT OR IGNORE INTO command_tracking (repo, issue_number, comment_id, command) VALUES (?, ?, ?, ?)',
  ).run(repo, issueNumber, commentId, command)
}
