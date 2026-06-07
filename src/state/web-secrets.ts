import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'

const SESSION_SECRET_KEY = 'session_secret'
const LOOPBACK_TOKEN_KEY = 'loopback_token'

const SESSION_SECRET_BYTES = 32
const LOOPBACK_TOKEN_BYTES = 24

interface RawRow {
  value: string
}

/**
 * Durable store for the web server's session-cookie signing secret and the
 * loopback mutation token. Persisting these keeps browser sessions and the
 * saved loopback token valid across `night-orch web` restarts — without it,
 * every restart mints new secrets and locks operators out.
 */
export class WebSecretStore {
  constructor(private db: Database.Database) {}

  /** Stable secret used to HMAC-sign session cookies. */
  getOrCreateSessionSecret(): Buffer {
    const value = this.getOrCreate(SESSION_SECRET_KEY, () =>
      randomBytes(SESSION_SECRET_BYTES).toString('base64'),
    )
    return Buffer.from(value, 'base64')
  }

  /** Stable loopback mutation token (`base64url`). */
  getOrCreateLoopbackToken(): string {
    return this.getOrCreate(LOOPBACK_TOKEN_KEY, () =>
      randomBytes(LOOPBACK_TOKEN_BYTES).toString('base64url'),
    )
  }

  private get(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM web_secrets WHERE key = ?')
      .get(key) as RawRow | undefined
    return row ? row.value : null
  }

  /**
   * Read the value for `key`, generating and persisting one if absent.
   * Uses `INSERT OR IGNORE` then re-reads so a concurrent writer (two web
   * processes under WAL) can never make callers diverge on the value.
   */
  private getOrCreate(key: string, generate: () => string): string {
    const existing = this.get(key)
    if (existing !== null) {
      return existing
    }

    const candidate = generate()
    this.db
      .prepare('INSERT OR IGNORE INTO web_secrets (key, value) VALUES (?, ?)')
      .run(key, candidate)

    const stored = this.get(key)
    if (stored === null) {
      throw new Error(`Failed to persist web secret '${key}'`)
    }
    return stored
  }
}
