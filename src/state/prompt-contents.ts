import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

/**
 * Content-addressed prompt storage.
 *
 * Most night-orch runs share the same system prompt template, so storing
 * the full string per compilation would bloat the DB ~1 MB per typical run.
 * Instead, every prompt body is hashed (SHA-256) and stored once in
 * `prompt_contents`; `prompt_compilations` rows carry only the hash.
 *
 * A bounded LRU caches "I already inserted this SHA" so the hot path
 * (planner/coder system prompt — same across most runs) avoids the
 * round-trip SELECT before every INSERT OR IGNORE.
 */
const LRU_CAPACITY = 256

const seenShas = new Map<string, true>()

function rememberSha(sha: string): void {
  // Map iteration order is insertion order — re-insert to refresh recency.
  if (seenShas.has(sha)) {
    seenShas.delete(sha)
    seenShas.set(sha, true)
    return
  }
  seenShas.set(sha, true)
  if (seenShas.size > LRU_CAPACITY) {
    const oldest = seenShas.keys().next().value
    if (oldest !== undefined) seenShas.delete(oldest)
  }
}

/**
 * Returns the SHA256 of `content`, inserting into `prompt_contents` if
 * unknown. Safe to call concurrently — the underlying INSERT OR IGNORE is
 * idempotent. The in-memory LRU avoids the SQLite hit on repeat compiles
 * within the same process.
 */
export function getOrInsertContent(db: Database.Database, content: string): string {
  const sha = createHash('sha256').update(content).digest('hex')
  if (seenShas.has(sha)) {
    rememberSha(sha)
    return sha
  }
  db.prepare(
    `INSERT OR IGNORE INTO prompt_contents (sha, content, byte_size, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sha, content, Buffer.byteLength(content, 'utf8'), Date.now())
  rememberSha(sha)
  return sha
}

export function getPromptContent(db: Database.Database, sha: string): string | null {
  const row = db.prepare('SELECT content FROM prompt_contents WHERE sha = ?').get(sha) as
    | { content: string }
    | undefined
  return row?.content ?? null
}

/** Exposed for tests only. */
export function _resetLruForTest(): void {
  seenShas.clear()
}
