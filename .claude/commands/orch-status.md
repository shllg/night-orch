---
allowed-tools: Bash, Read
description: Query night-orch SQLite DB for recent runs, active leases, costs, and stuck/failed runs
user-invocable: true
---

# /orch-status — Operational Status

Query the night-orch database for operational status.

## Input

$ARGUMENTS — optional: "runs", "leases", "costs", "stuck", or "all" (default: all)

## Process

1. **Find the database**:
   ```bash
   # Check common locations
   ls -la *.db data/*.db state/*.db 2>/dev/null
   ```
   If no database found, report "No night-orch database found. The tool may not have been run yet." and exit.

2. **Recent runs** (last 24h):
   ```bash
   sqlite3 -header -column <db> "
     SELECT run_id, repo, issue_number, status, started_at, completed_at,
            ROUND((julianday(COALESCE(completed_at, datetime('now'))) - julianday(started_at)) * 86400) as duration_sec
     FROM runs
     WHERE started_at > datetime('now', '-24 hours')
     ORDER BY started_at DESC
     LIMIT 20;
   "
   ```

3. **Active leases**:
   ```bash
   sqlite3 -header -column <db> "
     SELECT lease_id, repo, issue_number, acquired_at,
            ROUND((julianday(datetime('now')) - julianday(acquired_at)) * 60) as age_min
     FROM leases
     WHERE released_at IS NULL
     ORDER BY acquired_at DESC;
   "
   ```

4. **Daily costs** (last 7 days):
   ```bash
   sqlite3 -header -column <db> "
     SELECT DATE(started_at) as day,
            COUNT(*) as runs,
            SUM(prompt_tokens) as prompt_tok,
            SUM(completion_tokens) as completion_tok,
            SUM(prompt_tokens + completion_tokens) as total_tok
     FROM runs
     WHERE started_at > datetime('now', '-7 days')
     GROUP BY day
     ORDER BY day DESC;
   "
   ```

5. **Stuck/failed runs**:
   ```bash
   sqlite3 -header -column <db> "
     SELECT run_id, repo, issue_number, status, started_at,
            ROUND((julianday(datetime('now')) - julianday(started_at)) * 60) as age_min
     FROM runs
     WHERE status IN ('running', 'failed', 'timeout')
       AND started_at > datetime('now', '-48 hours')
     ORDER BY started_at DESC;
   "
   ```

## Notes

- All queries use parameterized SQL (no injection risk in these static queries)
- Adjust table/column names if the schema differs from expected
- If queries fail, show the error and suggest checking the schema with `.schema`
