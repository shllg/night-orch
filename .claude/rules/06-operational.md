# Operational Rules

Applies to: `src/cli/**`, `src/state/**`, `src/ops/**`

## Structured Logging

- Always include context fields: `runId`, `repo`, `issueNumber`
- Use pino child loggers: `logger.child({ runId, repo })`
- Log levels: `error` (action needed), `warn` (degraded), `info` (milestones), `debug` (detail)
- NEVER log at `info` in hot loops — use `debug`

## Database Operations

- All queries MUST be parameterized — no string interpolation in SQL
- Use WAL mode for concurrent read access
- Wrap multi-statement operations in transactions
- Handle `SQLITE_BUSY` with retry logic

## Crash Recovery

- The engine reads phase checkpoints on startup to detect incomplete runs
- Incomplete runs can be resumed from the last completed phase
- Lease system prevents two engines from processing the same issue
- Stale leases (>30 min) are automatically released

## Lease Management

- Acquire lease before starting work on an issue
- Release lease on completion (success or failure)
- Heartbeat during long operations to prevent stale detection
- NEVER hold a lease across process restarts

## Cost Tracking

- Track cumulative token usage per run
- Store in DB for reporting
- CLI `status` command reads from DB for dashboard view

## Cleanup Operations

- `ops/cleanup.ts` handles: stale worktrees, orphaned branches, expired leases
- Cleanup is idempotent — safe to run multiple times
- Log what was cleaned up at `info` level
