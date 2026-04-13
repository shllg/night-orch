import type Database from 'better-sqlite3'
import type {
  FileLoopDifficulty,
  FileLoopFileState,
  FileLoopFileStatus,
} from './types.js'

interface RawFileLoopFileStateRow {
  repo: string
  file_path: string
  last_touched_at: string | null
  last_status: string | null
  last_summary_short: string | null
  last_difficulty_flag: string | null
  touch_count: number | null
}

export interface UpsertFileLoopFileStateParams {
  repo: string
  filePath: string
  lastTouchedAt?: string | null
  lastStatus?: FileLoopFileStatus | null
  lastSummaryShort?: string | null
  lastDifficultyFlag?: FileLoopDifficulty | null
  incrementTouchCount?: boolean
}

export class FileLoopFileStateStore {
  constructor(private readonly db: Database.Database) {}

  get(repo: string, filePath: string): FileLoopFileState | null {
    const row = this.db
      .prepare('SELECT * FROM file_loop_file_state WHERE repo = ? AND file_path = ?')
      .get(repo, filePath) as RawFileLoopFileStateRow | undefined
    return row ? mapFileStateRow(row) : null
  }

  listForRepo(repo: string): FileLoopFileState[] {
    const rows = this.db
      .prepare('SELECT * FROM file_loop_file_state WHERE repo = ? ORDER BY file_path ASC')
      .all(repo) as RawFileLoopFileStateRow[]
    return rows.map(mapFileStateRow)
  }

  upsert(params: UpsertFileLoopFileStateParams): void {
    this.db
      .prepare(
        `INSERT INTO file_loop_file_state (
          repo, file_path, last_touched_at, last_status, last_summary_short, last_difficulty_flag, touch_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo, file_path) DO UPDATE SET
          last_touched_at = excluded.last_touched_at,
          last_status = excluded.last_status,
          last_summary_short = excluded.last_summary_short,
          last_difficulty_flag = excluded.last_difficulty_flag,
          touch_count = CASE
            WHEN excluded.touch_count > 0 THEN file_loop_file_state.touch_count + excluded.touch_count
            ELSE file_loop_file_state.touch_count
          END`,
      )
      .run(
        params.repo,
        params.filePath,
        params.lastTouchedAt ?? null,
        params.lastStatus ?? null,
        params.lastSummaryShort ?? null,
        params.lastDifficultyFlag ?? null,
        params.incrementTouchCount ? 1 : 0,
      )
  }
}

function mapFileStateRow(row: RawFileLoopFileStateRow): FileLoopFileState {
  return {
    repo: row.repo,
    filePath: row.file_path,
    lastTouchedAt: row.last_touched_at,
    lastStatus: coerceFileStatus(row.last_status),
    lastSummaryShort: row.last_summary_short,
    lastDifficultyFlag: coerceDifficulty(row.last_difficulty_flag),
    touchCount: row.touch_count ?? 0,
  }
}

function coerceFileStatus(value: string | null): FileLoopFileStatus | null {
  switch (value) {
    case 'edited':
    case 'noop':
    case 'deferred':
    case 'skipped':
    case 'error':
      return value
    default:
      return null
  }
}

function coerceDifficulty(value: string | null): FileLoopDifficulty | null {
  switch (value) {
    case 'trivial':
    case 'moderate':
    case 'complex':
      return value
    default:
      return null
  }
}
