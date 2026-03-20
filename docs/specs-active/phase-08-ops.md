# Phase 8: Sync + Cleanup + Retry + Polish

## Objective

Implement the `sync`, `cleanup`, and `retry` commands, stale state reconciliation, crash recovery on startup, and the long-running `run` poller. After this phase, the orchestrator handles real-world operational scenarios: external label changes, merged PRs, stale leases, and manual retries.

## Dependencies

- **Phase 7**: Notifications working (sync/cleanup may trigger notifications).
- **Phase 6**: PR publishing, label management.
- **Phase 5**: Loop engine.
- **Phase 2**: ForgeAdapter, LeaseManager, RunManager.
- **Phase 1**: Config, SQLite, logger.

## Inputs

- SQLite state (runs, leases, issue_links)
- GitHub state (issues, PRs, labels)
- Config (pollIntervalSeconds, repos)

## Outputs

- `sync` command: reconciles local state with GitHub
- `cleanup` command: removes stale worktrees, leases, logs
- `retry` command: forces re-run of a specific issue
- `run` command: long-running poller with graceful shutdown
- Crash recovery on startup
- `--dry-run` support on all commands

---

## Interfaces / Types

### Sync Engine

```typescript
interface SyncResult {
  reconciledRuns: SyncAction[];
  expiredLeases: number;
  orphanedWorktrees: string[];
  labelCorrections: LabelCorrection[];
}

interface SyncAction {
  repo: string;
  issueNumber: number;
  action: 'completed' | 'closed' | 'label_corrected' | 'lease_expired' | 'stale_cleared';
  reason: string;
  prNumber: number | null;
}

interface LabelCorrection {
  repo: string;
  issueNumber: number;
  added: string[];
  removed: string[];
  reason: string;
}

interface SyncEngine {
  /** Full reconciliation of local state with GitHub.
   *  1. Check all runs with status 'running' — is issue still open? is PR merged?
   *  2. Clean expired leases
   *  3. Fix label mismatches (DB says running, GitHub missing running label)
   *  4. Mark completed: PR merged → run completed, remove worktree option
   *  5. Mark closed: issue closed externally → run completed
   *  6. Detect orphaned worktrees (no matching run)
   */
  reconcile(dryRun: boolean): Promise<SyncResult>;
}
```

### Cleanup Engine

```typescript
interface CleanupResult {
  removedWorktrees: string[];
  removedBranches: string[];
  expiredLeases: number;
  archivedLogs: string[];
  freedDiskMb: number;
}

interface CleanupOptions {
  /** Remove worktrees for completed/merged runs. Default: true. */
  completedWorktrees: boolean;
  /** Remove worktrees for error runs older than N days. Default: 7. */
  errorWorktreeAgeDays: number;
  /** Remove branches for merged PRs. Default: false (conservative). */
  mergedBranches: boolean;
  /** Archive logs older than N days. Default: 30. */
  logArchiveAgeDays: number;
  /** Dry run — show what would be removed. */
  dryRun: boolean;
}

interface CleanupEngine {
  run(options: CleanupOptions): Promise<CleanupResult>;
}
```

### Retry

```typescript
interface RetryEngine {
  /** Force a re-run of a specific issue.
   *  1. Find existing run for repo + issue
   *  2. If blocked/error: reset status to queued
   *  3. If review_ready: reset for another pass (with existing plan)
   *  4. Remove stale labels (blocked, error)
   *  5. Add ready label
   *  6. Release any existing lease
   *  7. Optionally: start loop immediately (if --immediate flag) */
  retry(repo: string, issueNumber: number, options: RetryOptions): Promise<void>;
}

interface RetryOptions {
  immediate: boolean;     // start loop right away vs just queue
  resetPlan: boolean;     // re-run planner or reuse existing plan
  dryRun: boolean;
}
```

### Run Poller

```typescript
interface Poller {
  /** Start the long-running poll loop.
   *  1. On startup: run sync to reconcile stale state (crash recovery)
   *  2. Poll at configured interval
   *  3. Each cycle: discover → claim → loop → publish → notify → release
   *  4. Serial only in v1 (one issue at a time)
   *  5. Graceful shutdown on SIGINT/SIGTERM */
  start(): Promise<void>;

  /** Stop the poller gracefully. Waits for current run to complete. */
  stop(): Promise<void>;
}
```

### Graceful Shutdown

```typescript
interface ShutdownHandler {
  /** Register SIGINT/SIGTERM handlers.
   *  On signal:
   *  1. Set shutdown flag (no new runs accepted)
   *  2. Wait for current run to complete (up to timeout)
   *  3. Release all leases
   *  4. Close DB
   *  5. Exit cleanly */
  register(onShutdown: () => Promise<void>): void;
}
```

---

## Config Schema Additions

No new top-level fields. Uses existing config:

```yaml
github:
  pollIntervalSeconds: 300

storage:
  worktreeRoot: ~/code/.night-orch/worktrees
  logsRoot: ~/code/.night-orch/logs
```

---

## Files to Create

```
src/
  ops/
    sync.ts                — SyncEngine implementation
    cleanup.ts             — CleanupEngine implementation
    retry.ts               — RetryEngine implementation
  poller/
    poller.ts              — Long-running poll loop
    shutdown.ts            — Graceful shutdown handler
  cli/
    commands/
      run.ts               — (replace stub) wire up poller
      run-once.ts          — (update) full single-cycle: discover → loop → publish → notify
      sync.ts              — (replace stub) wire up SyncEngine
      cleanup.ts           — (replace stub) wire up CleanupEngine
      retry.ts             — (replace stub) wire up RetryEngine
```

### File Descriptions

- **`ops/sync.ts`**: Iterates all runs in DB with active/running status. For each, queries GitHub for issue state and PR state. Reconciles mismatches. Cleans expired leases. Reports all actions taken.
  - PR merged → mark run completed, update labels
  - Issue closed → mark run completed
  - Run status `running` but lease expired → check if worker still alive, else mark stale
  - Labels out of sync → correct them
- **`ops/cleanup.ts`**: Scans worktree root for managed directories. Cross-references with DB runs. Removes worktrees/branches for completed/old-error runs. Archives old log files (move to `.archive/` or delete). Reports disk freed.
- **`ops/retry.ts`**: Finds existing run, resets state, clears stale labels, re-adds ready label. With `--immediate`, directly starts a new loop cycle. With `--reset-plan`, clears stored plan to force re-planning.
- **`poller/poller.ts`**: `setInterval`-based loop. Each tick: call `discoverEligibleIssues` for each repo, claim first eligible, run full loop. Serial: waits for current run to finish before polling again. Logs each cycle start/end.
- **`poller/shutdown.ts`**: Registers `process.on('SIGINT')` and `process.on('SIGTERM')`. Sets flag to prevent new runs. Waits for active run (with timeout, default 5 minutes). Releases leases. Closes DB. Exits 0.
- **`cli/commands/run.ts`**: Creates poller, starts it. Runs `sync` on startup for crash recovery. Handles `--dry-run` (polls and logs but doesn't execute).
- **`cli/commands/run-once.ts`**: Complete single cycle: discover → claim → prepare worktree → loop → publish → notify → release lease → update labels. Already partially implemented, now wired to full pipeline.
- **`cli/commands/sync.ts`**: Runs `SyncEngine.reconcile()`, prints results table.
- **`cli/commands/cleanup.ts`**: Runs `CleanupEngine.run()` with CLI flags for options. Prints what was removed/archived.
- **`cli/commands/retry.ts`**: Parses `<repo> <issue-number>` args, runs `RetryEngine.retry()`.

---

## Startup / Crash Recovery Flow

```
run command startup:
  1. Load config
  2. Open DB
  3. Run sync (crash recovery):
     a. Find runs with status='running' and expired leases
     b. For each: check GitHub state
     c. If issue still open and no PR: mark as queued (will be retried)
     d. If PR exists and merged: mark as completed
     e. If PR exists and open: mark as review_ready
     f. Clean expired leases
     g. Fix label mismatches
  4. Start polling loop
```

---

## Tests

### Sync Tests (`test/ops/sync.test.ts`)
- Running run + PR merged → completed
- Running run + issue closed → completed
- Running run + expired lease + no PR → queued (retry)
- Running run + labels missing → labels corrected
- Completed run → no change
- Dry run → reports actions without mutations

### Cleanup Tests (`test/ops/cleanup.test.ts`)
- Completed run worktree → removed
- Error run > 7 days → removed
- Error run < 7 days → kept
- Active run worktree → kept
- Orphaned worktree (no DB record) → flagged (not auto-removed)
- Dry run → reports but doesn't remove
- Merged branch deletion (when option enabled)

### Retry Tests (`test/ops/retry.test.ts`)
- Blocked run → reset to queued, labels updated
- Error run → reset to queued, labels updated
- review_ready run → reset to queued (for another pass)
- `--reset-plan` clears stored plan
- `--immediate` starts loop directly
- Non-existent run → clear error message
- Already-running run → reject with message

### Poller Tests (`test/poller/poller.test.ts`)
- Polls at configured interval
- Processes one issue per cycle (serial)
- Graceful shutdown waits for current run
- No eligible issues → logs and waits for next cycle
- Error in cycle → logs, continues polling (doesn't crash)

### Shutdown Tests (`test/poller/shutdown.test.ts`)
- SIGINT sets shutdown flag
- Active run allowed to complete before exit
- Leases released on shutdown
- DB closed on shutdown
- Shutdown timeout forces exit after 5 minutes

### Integration Test (`test/ops/full-ops.test.ts`)
- Simulate crash: start run → kill → restart → sync detects stale → retry succeeds
- Cleanup after merged PR removes worktree

---

## Acceptance Criteria

1. `sync` reconciles local DB with GitHub state (merged PRs, closed issues, stale labels)
2. `cleanup` removes stale worktrees, expired leases, and old logs
3. `retry <repo> <issue>` resets a blocked/error run for reprocessing
4. `run` starts long-running poller with configured interval
5. Crash recovery on startup: stale running states detected and reconciled
6. Graceful shutdown on SIGINT/SIGTERM: waits for current run, releases leases
7. Serial processing: only one issue processed at a time
8. `--dry-run` supported on all commands
9. All operational state transitions trigger appropriate notifications
10. All tests pass: `pnpm test`
