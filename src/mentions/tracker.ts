import type Database from 'better-sqlite3'

export class MentionTracker {
  constructor(private db: Database.Database) {}

  wasPosted(repo: string, prNumber: number, mentionKey: string, commitSha: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM mention_tracking WHERE repo = ? AND pr_number = ? AND mention_key = ? AND commit_sha = ?',
      )
      .get(repo, prNumber, mentionKey, commitSha)
    return row !== undefined
  }

  recordPosted(repo: string, prNumber: number, mentionKey: string, commitSha: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO mention_tracking (repo, pr_number, mention_key, commit_sha) VALUES (?, ?, ?, ?)',
      )
      .run(repo, prNumber, mentionKey, commitSha)
  }
}
