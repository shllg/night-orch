---
allowed-tools: Bash, Read, Glob, Grep
description: Debug a specific night-orch run by ID — traces DB state, logs, checkpoints, and root cause
user-invocable: true
---

# /orch-debug-run — Debug a Specific Run

Investigate a specific run to find what went wrong.

## Input

$ARGUMENTS — run ID to investigate (required)

## Process

1. **Query run record**:
   ```bash
   sqlite3 -header -column <db> "
     SELECT * FROM runs WHERE run_id = '<run_id>';
   "
   ```

2. **Trace checkpoints**:
   ```bash
   sqlite3 -header -column <db> "
     SELECT phase, status, started_at, completed_at, error_message
     FROM checkpoints
     WHERE run_id = '<run_id>'
     ORDER BY started_at;
   "
   ```
   Identify: which phase completed? Which failed? What was the error?

3. **Check lease history**:
   ```bash
   sqlite3 -header -column <db> "
     SELECT * FROM leases
     WHERE run_id = '<run_id>'
     ORDER BY acquired_at;
   "
   ```

4. **Find related logs** (if log files exist):
   ```bash
   # Search for run ID in log files
   rg '<run_id>' logs/ *.log 2>/dev/null | head -50
   ```

5. **Check worker output** (if stored):
   ```bash
   sqlite3 -header -column <db> "
     SELECT phase, worker_type, token_usage, error_message
     FROM worker_calls
     WHERE run_id = '<run_id>'
     ORDER BY started_at;
   "
   ```

6. **Root cause analysis**:
   Based on the data gathered, determine:
   - Which phase failed?
   - What was the error?
   - Was it a worker timeout, API error, budget exceeded, or logic bug?
   - Is the issue in night-orch code or external (API rate limit, worker crash)?

## Output Format

```markdown
## Debug: Run <run_id>

### Run Summary
- Repo: ...
- Issue: #...
- Status: ...
- Duration: ...
- Total tokens: ...

### Checkpoint Timeline
| Phase | Status | Duration | Error |
|-------|--------|----------|-------|
| ... | ... | ... | ... |

### Root Cause
[Analysis of what went wrong]

### Suggested Fix
[What to do about it — retry, fix code, adjust config]
```

## Notes

- Adjust table/column names to match actual schema
- If the run ID is not found, list recent runs to help the user find the right one
