# Phase 1: Skeleton CLI + Config + State

## Objective

Scaffold the `night-orch` CLI tool with config loading, validation, SQLite state initialization, and the `doctor` diagnostic command. This phase produces a runnable CLI that validates its own setup.

## Dependencies

None — this is the foundation phase.

## Inputs

- YAML config file (user-created, validated by the tool)
- Environment variables for tokens

## Outputs

- Runnable `night-orch` CLI with commands: `run` (stub), `run-once` (stub), `doctor`, `sync` (stub), `retry` (stub), `cleanup` (stub), `notify-test` (stub)
- Validated config object available to all subsystems
- Initialized SQLite database with schema

---

## Config Schema (Zod)

The full YAML config validated at startup. All paths support `~` and `$ENV_VAR` expansion.

```yaml
version: 1

github:
  tokenEnv: GITHUB_TOKEN              # env var name, NOT the token value
  apiBaseUrl: https://api.github.com
  pollIntervalSeconds: 300
  appMentions:
    claude:
      enabled: true
      commentTemplate: "@claude Please review this PR and apply fixes if needed."
    codex:
      enabled: false
      commentTemplate: "@codex please review and patch any remaining issues."

storage:
  dbPath: ~/.config/night-orch/state.db
  worktreeRoot: ~/code/.night-orch/worktrees
  logsRoot: ~/code/.night-orch/logs

notifications:
  channels:
    - type: console
    - type: webhook
      urlEnv: NIGHT_ORCH_WEBHOOK_URL
  events:
    onRunStarted: false
    onBlocked: true
    onPrReady: true
    onError: true
    onRetryExhausted: true

loop:
  maxReviewIterations: 4
  maxTotalAgentPasses: 10
  stopOnPlannerFailure: true
  requireVerificationPass: true
  reviewApprovalKeyword: APPROVED
  reviewNeedsChangesKeyword: CHANGES_REQUIRED
  blockOnAmbiguousReview: true

security:
  maxChangedFiles: 50                  # diff-size guard
  maxChangedLines: 5000                # diff-size guard
  maxDailyCostUsd: 50                  # cost circuit breaker
  maxCostPerRunUsd: 10                 # per-run budget

workerProfiles:
  claude-default:
    type: claude
    command: claude
    args: [-p]
    workerTimeoutSeconds: 1800
    minimalEnv: true                   # whitelist env vars only
    runtimeWrapper: null               # future: firejail, docker, systemd-run
    env: {}
  codex-default:
    type: codex
    command: codex
    args: [exec, --json]
    workerTimeoutSeconds: 1800
    minimalEnv: true
    runtimeWrapper: null
    env: {}

metrics:
  enabled: true
  port: 9090
  host: 127.0.0.1

repos:
  - repo: myorg/myrepo
    forge: github
    apiBaseUrl: https://api.github.com
    localPath: ~/code/myrepo
    baseBranch: main
    branchPrefix: orch
    labels:
      ready: [orch:ready]
      running: orch:running
      blocked: [orch:blocked, orch:needs-human]
      reviewReady: orch:review-ready
      error: orch:error
      retry: orch:retry
    defaults:
      planner: claude
      coder: codex
      reviewer: claude
      doneMode: pr-ready
      notifyPriority: normal
      prMentions: [claude]
    environment:
      defaultMode: shared
      dedicated:
        compose:
          file: docker-compose.dev.yml
          services: [db, redis]
          projectName: "orch-{issue}"
        env:
          copyFrom: .env
          overrides:
            PORT: "{auto:5101-5199}"
          overrideFiles: []
        healthcheck: "curl -f http://localhost:{port}/health"
        teardownOnComplete: true
      shared:
        requireRunning: true
        healthcheck: "curl -f http://localhost:3000/health"
      bootstrap:
        - command: pnpm install --frozen-lockfile
          when: always
      cleanup:
        - command: docker compose -p "orch-{issue}" down -v
          when: dedicated
    verify:
      - pnpm lint
      - pnpm typecheck
      - pnpm test
    prompts:
      plannerSystem: .night-orch/prompts/planner-system.md
      coderSystem: .night-orch/prompts/coder-system.md
      reviewerSystem: .night-orch/prompts/reviewer-system.md
    selectors:
      includeLabelsAny: [orch:ready]
      excludeLabelsAny: [orch:blocked, orch:error]
    agents:
      claude: claude-default
      codex: codex-default
```

### Validation Rules
- `version` must be `1`
- `tokenEnv` must reference an env var name (reject if it looks like a literal token)
- All paths expanded (`~` → home, `$VAR` → env value)
- `repos[].forge` must be `github` or `forgejo`
- Agent role labels: reject if both `plan:claude` and `plan:codex` on same issue
- Worker profiles referenced by repos must exist
- `workerTimeoutSeconds` must be > 0

---

## SQLite Schema

Database at `storage.dbPath`, initialized with WAL mode and busy_timeout.

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  issue_node_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  -- status: queued, running, blocked, review_ready, error, completed
  planner TEXT,
  coder TEXT,
  reviewer TEXT,
  iteration_count INTEGER DEFAULT 0,
  current_phase TEXT,          -- phase checkpointing
  phase_data TEXT,             -- JSON: artifacts from completed phases
  started_at TEXT,
  ended_at TEXT,
  last_error TEXT,
  pr_number INTEGER,
  branch_name TEXT,
  branch_slug TEXT,            -- pinned slug, never re-derived
  worktree_path TEXT,
  estimated_cost_usd REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leases (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  lease_owner TEXT NOT NULL,
  leased_at TEXT DEFAULT (datetime('now')),
  leased_until TEXT NOT NULL,
  PRIMARY KEY (repo, issue_number)
);

CREATE TABLE IF NOT EXISTS issue_links (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  branch_name TEXT NOT NULL,
  branch_slug TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (repo, issue_number)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  repo TEXT,
  issue_number INTEGER,
  event_type TEXT NOT NULL,
  phase TEXT,
  data TEXT,                   -- JSON payload
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_costs (
  date TEXT PRIMARY KEY,       -- YYYY-MM-DD
  total_cost_usd REAL DEFAULT 0,
  run_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_issue ON runs(repo, issue_number);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
```

---

## Files to Create

```
src/
  cli/
    index.ts                 — commander setup, all commands registered
    commands/
      run.ts                 — stub: "not yet implemented"
      run-once.ts            — stub: "not yet implemented"
      doctor.ts              — full implementation
      sync.ts                — stub
      retry.ts               — stub
      cleanup.ts             — stub
      notify-test.ts         — stub
  config/
    schema.ts                — Zod schema for full config
    loader.ts                — YAML parse → Zod validate → path expansion
    paths.ts                 — path expansion utilities (~, $ENV)
  state/
    db.ts                    — SQLite init, WAL mode, migration runner
    migrations/
      001-initial.ts         — CREATE TABLE statements
  utils/
    logger.ts                — pino setup with redaction
    ids.ts                   — run ID generation (nanoid or uuid)
```

---

## `doctor` Command

Validates the entire setup. Each check prints pass/fail with details.

### Checks
1. **Config file exists and parses** — load YAML, run Zod validation
2. **Required env vars set** — check `tokenEnv` and any `urlEnv` values
3. **GitHub auth works** — `GET /user` with the configured token
4. **CLI binaries available** — check `claude --version`, `codex --version` exist on PATH
5. **Repo paths exist** — each `repos[].localPath` is a directory with a `.git`
6. **Base branches exist** — each `repos[].baseBranch` exists in the local repo
7. **Worktree root writable** — can create files in `storage.worktreeRoot`
8. **DB writable** — open/create SQLite DB, run migrations
9. **Verify commands exist** — check first word of each verify command is on PATH
10. **Worker profiles valid** — referenced commands exist
11. **firejail available** (if any worker uses runtimeWrapper with firejail)

### Output Format
```
night-orch doctor

✓ Config loaded from ~/.config/night-orch/config.yaml
✓ GITHUB_TOKEN is set
✓ GitHub auth OK (user: sascha)
✓ claude CLI found (v1.2.3)
✓ codex CLI found (v0.5.1)
✓ Repo myorg/myrepo: ~/code/myrepo exists, branch main exists
✓ Worktree root ~/code/.night-orch/worktrees is writable
✓ Database initialized at ~/.config/night-orch/state.db
✓ Verify commands: pnpm found
✗ firejail not found (optional: needed for sandboxed worker profiles)

9/10 checks passed
```

---

## Tests

### Config Tests (`test/config/`)
- Valid config parses without errors
- Missing required fields produce clear Zod errors
- Path expansion: `~` → `$HOME`, `$VAR` → value, undefined `$VAR` → error
- Literal token detection: reject if `tokenEnv` value looks like `ghp_...` or `ghs_...`
- Invalid `forge` value rejected
- Conflicting agent role labels detected
- Worker profile references validated

### State Tests (`test/state/`)
- DB initializes with WAL mode
- Migrations create all expected tables
- Migration runner is idempotent (safe to run twice)
- `busy_timeout` is set

### CLI Tests (`test/cli/`)
- `--help` shows all commands
- `--version` shows version
- `doctor` with valid config succeeds
- `doctor` with missing config fails with clear message

---

## Acceptance Criteria

1. `npx tsx src/cli/index.ts --help` shows all commands
2. `npx tsx src/cli/index.ts doctor --config examples/config.example.yaml` runs all checks
3. Config with errors produces readable Zod validation messages
4. SQLite DB is created with all tables on first run
5. All tests pass: `pnpm test`
6. `--dry-run` flag accepted on `run` and `run-once` (stored in context, no behavior yet)
