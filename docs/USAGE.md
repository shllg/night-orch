# Night-Orch Usage Guide

This guide covers how to use night-orch's features. For configuration reference, see [CONFIGURATION.md](CONFIGURATION.md). For architecture details, see [OVERVIEW.md](OVERVIEW.md).

## How Night-Orch Works

Night-orch is a **central orchestrator** that runs as a single daemon on your machine. It manages one or more repositories from a single configuration file. You do **not** run it inside any project directory — it runs independently and reaches into your project clones via their local paths.

```
~/.config/night-orch/config.yaml   ← central config
~/.config/night-orch/state.db      ← SQLite state (runs, leases, costs)
~/code/.night-orch/worktrees/      ← isolated worktrees (managed by night-orch)

~/code/myproject/                  ← your existing clone (night-orch reads from this)
~/code/other-project/              ← another clone
```

Night-orch **never modifies your project clones directly**. It creates temporary git worktrees from them into its own storage area, does all AI work there, and pushes branches/PRs to the remote.

## Getting Started

### First-time setup

```bash
night-orch init
```

The interactive wizard walks you through:
1. GitHub token configuration
2. Repository URL and the path to your local clone
3. Project type detection (Node.js, Rust, Go, Python, Ruby)
4. Verify command suggestions based on your stack
5. Worker profile selection (Claude, Codex, or ACP)
6. Writing the config to `~/.config/night-orch/config.yaml`

You can add more repos later by editing the config — each `repos[]` entry points to a different local clone.

After the wizard completes, run diagnostics:

```bash
night-orch doctor      # validates config, auth, CLIs, repos, DB
night-orch labels-init # creates orchestration labels on GitHub
```

### Running the orchestrator

Run from anywhere — night-orch reads its config from `~/.config/night-orch/`:

```bash
night-orch run       # long-running daemon, polls all repos on interval
night-orch web       # web UI/API server (attach mode by default)
night-orch web --standalone  # run daemon + web UI in one process
night-orch run-once  # single poll cycle (useful for testing)
```

The daemon polls each configured repo for issues labeled `orch:ready`, processes them through the AI pipeline, and creates PRs. It runs continuously until you stop it (Ctrl+C).

### Monitoring

From any terminal:

```bash
night-orch status    # one-shot status snapshot
night-orch tui       # live-updating terminal dashboard
night-orch web       # browser UI at http://127.0.0.1:3200 by default
```

The `watch` command shows:
- Active runs with status, phase, iteration count, and cost
- Merge queue batches in progress
- Daily cost bar against budget
- Recent completed/errored/blocked runs
- Issue actions on selected runs: retry, retry fresh, rebase, and delete entry

### Multi-repo setup

Night-orch handles multiple repos in a single instance:

```yaml
repos:
  - repo: myorg/frontend
    localPath: ~/code/frontend
    maxConcurrentRuns: 1
    baseBranch: main
    verify: [pnpm lint, pnpm test]

  - repo: myorg/backend
    localPath: ~/code/backend
    maxConcurrentRuns: 2  # optional: increase per-repo parallel issue runs
    baseBranch: main
    verify: [cargo test, cargo clippy]
    workflow: minimal  # different pipeline for this repo
```

Repos are polled in parallel. By default, each repo runs one issue at a time; raise `maxConcurrentRuns` to process multiple issues concurrently in that repo.

---

## How Issues Are Processed

1. **Discovery** — the daemon polls each repo for open issues with configured labels (default: `orch:ready`)
2. **Triage** — issues are classified as trivial, standard, or architectural based on labels and body length
3. **Decomposition** (optional) — complex issues are split into independent sub-tasks
4. **Pipeline execution** — each issue runs through the configured workflow (default: Plan → Code → Verify → Review → Decide) in an isolated git worktree
5. **Publishing** — approved changes are committed, pushed, and a PR is created on the remote
6. **Merge queue** (optional) — approved PRs are batched, tested, and merged automatically

Planning-only override: if an issue also has the planning label (default `orch:planning`), night-orch runs a planning-only workflow and publishes exactly one PRD markdown file (no code/test/config changes).

### Label lifecycle

```
orch:ready → orch:running → orch:review-ready → (merged)
                  ↓                ↓
            orch:blocked     orch:merge-queued
                  ↓                ↓
            orch:error       orch:merge-failed
```

To retry a blocked or errored issue, remove the blocking label and add `orch:ready`, or use:

```bash
night-orch retry owner/repo 42
```

---

## Workflows

By default, night-orch uses this pipeline:

```
Plan → Code → Verify → Review → Decide
                 ↑                  │
                 └──── iterate ─────┘
```

### Custom workflows

Define named workflows in your config to change the pipeline per repo:

```yaml
workflows:
  minimal:
    steps:
      - { type: worker, id: code, role: coder }
      - { type: verify, id: verify }
      - { type: worker, id: review, role: reviewer }
      - { type: decide, id: decide, onIterate: code }

repos:
  - repo: org/simple-repo
    workflow: minimal    # skips planning entirely
```

### Adding custom steps

You can add extra worker steps for specialized review:

```yaml
workflows:
  security-focused:
    steps:
      - { type: worker, id: plan, role: planner, skipWhen: trivial }
      - { type: worker, id: code, role: coder, continueFrom: plan }
      - { type: verify, id: verify }
      - { type: worker, id: security-review, role: reviewer, prompt: prompts/security.md }
      - { type: worker, id: review, role: reviewer }
      - { type: decide, id: decide, onIterate: code }
```

### Step types

| Type | Purpose |
|------|---------|
| `worker` | Invoke an AI agent (planner, coder, reviewer, or custom role) |
| `verify` | Run configured test/lint/typecheck commands |
| `decide` | Evaluate results and route to publish, iterate, or block |

### Step options

- `skipWhen: trivial` — skip this step for trivially-triaged issues
- `continueFrom: plan` — continue the AI session from a prior step when both steps use the same agent (reduces token usage, improves context)
- `prompt: path/to/template.md` — use a custom system prompt instead of the default

---

## Issue Decomposition

When enabled, night-orch can automatically split complex issues into smaller sub-tasks that execute in parallel.

### Enabling decomposition

```yaml
loop:
  decompose: true
  maxSubtasks: 5
  maxConcurrentSubtasks: 3
```

### How it works

1. Issues classified as `standard` triage with a body >500 chars (or 3+ numbered items) trigger decomposition
2. The planner agent analyzes the issue and decides whether to split it
3. If split, each sub-task gets its own git worktree and runs the full workflow independently
4. Sub-tasks execute in parallel waves based on their dependency graph
5. Results are collected and the parent issue is marked as complete or blocked

### When to use it

- Issues with multiple independent requirements ("add endpoint X, update docs, add migration")
- Issues touching different parts of the codebase that won't conflict
- NOT for tightly-coupled changes where order matters

---

## Merge Queue

The merge queue batches approved PRs, tests them together, and automatically merges on success. On failure, it bisects to find the breaking PR.

### Enabling the merge queue

```yaml
repos:
  - repo: org/repo
    mergeQueue:
      enabled: true
      batchSize: 5
      requireApproval: true
      retryFlakyOnce: true
```

### How it works

Each poll cycle:

1. **Scan** — find `review_ready` PRs with passing CI and human approval
2. **Batch** — group up to `batchSize` eligible PRs
3. **Stage** — create a staging branch, sequentially merge each PR's head
   - PRs that conflict are ejected from the batch (remaining PRs continue)
4. **Test** — push the staging branch, wait for CI
5. **On pass** — fast-forward the base branch to the staging tip, close merged PRs
6. **On fail** — bisect the batch (split in half, test each half, recurse)
7. **Culprit found** — the single PR that broke CI is labeled `orch:merge-failed`

### Flaky CI handling

With `retryFlakyOnce: true` (default), a failed batch is retried once before bisecting. This avoids unnecessary bisection due to flaky tests.

### Labels

- `orch:merge-queued` — PR has entered the merge queue
- `orch:merging` — PR's batch is currently being tested
- `orch:merge-failed` — PR was identified as the bisection culprit

---

## Multi-Agent Support

Night-orch supports multiple AI agent backends. Each role (planner, coder, reviewer) can use a different agent.

### Built-in adapters

| Type | Agent | Notes |
|------|-------|-------|
| `claude` | Claude Code CLI | Default. Uses `--output-format json`, session continuity via `--continue` |
| `codex` | Codex CLI | Uses `--output-last-message`, session continuity via `--resume` |
| `acp` | Any ACP agent | Via [acpx](https://github.com/openclaw/acpx) — supports Gemini, Claude, Codex, and 17+ agents |

### Configuring agents

```yaml
workerProfiles:
  claude-default:
    type: claude
    command: claude
    args: ["-p"]

  gemini-acp:
    type: acp
    command: gemini     # acpx agent name
    args: []

repos:
  - repo: org/repo
    agents:
      claude: claude-default
      gemini: gemini-acp
    defaults:
      planner: claude     # plan with Claude
      coder: claude       # code with Claude
      reviewer: gemini    # review with Gemini
```

### Session continuity

Agents retain context across pipeline phases when the agent implementation matches. For example, coder can continue planner context when both are on the same agent, and on iteration, coder continues from its own prior session. Cross-agent handoffs start a fresh session.

This is configured per-step in workflows via `continueFrom`:

```yaml
steps:
  - { type: worker, id: code, role: coder, continueFrom: plan }
```

---

## Reaction Engine

After a PR is created, night-orch monitors it for events and can automatically re-queue the issue for fixes.

### What triggers reactions

- **CI failure** on the PR — detected via GitHub check status
- **Human review with changes requested** — reviewer posts changes_requested
- **Inline review comments** — new code comments from humans

### How it works

Each poll cycle scans `review_ready` PRs for new events. When a reaction is detected:

1. The reaction context (CI output, review comments) is stored on the run
2. The issue is transitioned back to `queued` with reaction context
3. On the next poll cycle, the coder receives the reaction context and can address it

This happens automatically — no configuration needed beyond the standard setup.

---

## Comment Commands

Night-orch responds to commands posted as GitHub issue comments:

| Command | Action |
|---------|--------|
| `/orch retry` | Re-queue a blocked or errored issue |
| `/orch rebase` | Rebase the work branch onto the latest base |
| `/orch cancel` | Cancel an active run |
| `/orch continue` | Continue from where a blocked run left off |

### Configuration

```yaml
commentCommands:
  enabled: true              # default: true
  requireCollaborator: false  # default: false — if true, only collaborators can use commands
```

---

## CLI Reference

All commands can be run from any directory — night-orch reads its config from `~/.config/night-orch/config.yaml` by default. Override with `--config <path>`.

### `night-orch run`

Start the long-running poller daemon. Polls all configured repos on the configured interval, processes eligible issues, creates PRs. Also starts the embedded MCP HTTP/SSE server and Prometheus metrics endpoint.

Options: `--config`, `--trust-workspace`, `--dry-run`, `--log-level`

### `night-orch web`

Start the embedded web control surface. Serves the React/Tailwind frontend, a REST API under `/api/*`, and a WebSocket stream endpoint at `/ws`.

By default, `web` runs in attach mode: no poll loop, no metrics server, and no embedded MCP server are started in the web process.
Use `--standalone` to run poller + metrics + embedded MCP in the same process as the web server.

Default bind is `127.0.0.1:3200`. Use `--host` / `--port` to change this (for example when reverse-proxying through Caddy or nginx). Use `--allowed-host` (repeatable) to permit additional Host/Origin values when proxying.

Options: `--config`, `--trust-workspace`, `--dry-run`, `--log-level`, `--host`, `--allowed-host`, `--port`, `--snapshot-interval-ms`, `--standalone`

### `night-orch run-once`

Execute a single poll cycle and exit. Useful for testing and CI.

Options: `--config`, `--trust-workspace`, `--dry-run`, `--log-level`, `--repo`, `--issue`

### `night-orch init`

Interactive setup wizard. Guides you through creating a config file.

### `night-orch doctor`

Run diagnostic checks: config validity, environment variables, forge authentication, CLI binaries, repo paths, base branches, worktree root, database, verify commands.

### `night-orch status`

Show current state: active runs, active leases, daily cost against budget, recent run history.

### `night-orch tui`

Live-updating terminal dashboard. Refreshes every 2 seconds. Shows active runs, merge queue, cost bar, recent history, and issue actions (`retry`, `retry fresh`, `rebase`, `delete entry`). Press Ctrl+C to exit.

### `night-orch sync`

Reconcile database state with GitHub: mark runs for merged PRs as completed, detect closed issues, correct label mismatches, find orphaned worktrees.

### `night-orch retry <repo> <issue>`

Force re-run of a blocked or errored issue. Options: `--immediate` (process now instead of queuing), `--reset-plan` (discard prior plan and start fresh).

### `night-orch rebase <repo> <issue>`

Rebase a PR's branch onto the latest base branch, then run verify commands to check if code adjustments are needed. If verify fails after rebase, the issue is automatically re-queued for the coder to fix.

Options: `--no-check` (skip verify commands after rebase — just rebase and push).

Also available as a comment command: `/orch rebase` (with `--check` by default).

### `night-orch cleanup`

Remove stale worktrees, delete merged branches, archive old logs. Respects `storage.retention` settings.

### `night-orch labels-init [repo]`

Create or update orchestration labels on GitHub/Forgejo. Run this after initial setup or after adding new repos. Pass a repo slug to update a single repo, or omit for all configured repos.

### `night-orch notify-test`

Send a test notification through all configured channels. Verifies webhook URLs, SMTP credentials, etc.

### `night-orch mcp`

Start the MCP server on stdio transport (for Claude Code integration). Exposes 9 tools and 3 resources for querying and controlling night-orch.

---

## Cost Management

Night-orch tracks costs at two levels:

### Per-run budgets

```yaml
security:
  maxCostPerRunUsd: 10    # max cost per issue processing run
  maxDailyCostUsd: 50     # max total daily spend
```

When a budget is exceeded, the run is blocked with reason `cost_limit`.

### Cost estimation

- **Token-based** (preferred) — when the agent adapter reports token counts, cost is calculated from input/output token rates
- **Time-based** (fallback) — when token counts aren't available, cost is estimated at $0.008/minute per agent call

View costs:
- `night-orch status` — shows daily cost summary
- `night-orch watch` — live cost bar
- Prometheus metric: `night_orch_estimated_cost_dollars`

---

## Prometheus Metrics

When `metrics.enabled: true`, night-orch exposes metrics at `http://<host>:<port>/metrics`.

Key metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `night_orch_runs_total` | counter | Total runs by outcome |
| `night_orch_active_runs` | gauge | Currently active runs |
| `night_orch_daily_cost_usd` | gauge | Today's spend |
| `night_orch_run_duration_seconds` | histogram | Run duration distribution |
| `night_orch_agent_invocations_total` | counter | Agent calls by role and adapter |
| `night_orch_verify_runs_total` | counter | Verification pass/fail counts |
| `night_orch_pr_operations_total` | counter | PRs created/updated |

---

## MCP Integration

Night-orch exposes an MCP server for integration with Claude Code and other MCP clients.

### Tools (9)

| Tool | Description |
|------|-------------|
| `night-orch-status` | Operational snapshot |
| `night-orch-run-detail` | Full run history and events |
| `night-orch-list-runs` | Filtered run listing |
| `night-orch-cost-report` | Daily cost breakdown |
| `night-orch-retry` | Re-run an issue |
| `night-orch-sync` | Reconcile DB with GitHub |
| `night-orch-cleanup` | Remove stale resources |
| `night-orch-poll` | Trigger single poll cycle |
| `night-orch-list-issues` | List eligible/active issues |

### Usage

```bash
# Standalone MCP server (stdio)
night-orch mcp

# Embedded in daemon (HTTP/SSE)
night-orch run  # MCP server starts automatically on configured port
```
