# Night-Orch Usage Guide

This guide covers how to use night-orch's features. For configuration reference, see [CONFIGURATION.md](CONFIGURATION.md). For architecture details, see [OVERVIEW.md](OVERVIEW.md).

## How Night-Orch Works

Night-orch is a **central orchestrator** that runs as a single daemon on your machine. It manages one or more repositories from a central configuration file. You do **not** run it inside any project directory — it runs independently and reaches into your project clones via their local paths.

```
~/.config/night-orch/config.yaml   ← central config
~/.config/night-orch/state.db      ← SQLite state (runs, leases, costs)
~/code/.night-orch/worktrees/      ← isolated worktrees (managed by night-orch)

~/code/myproject/                  ← your existing clone (night-orch reads from this)
~/code/other-project/              ← another clone
```

Night-orch **never modifies your project clones directly**. It creates temporary git worktrees from them into its own storage area, does all AI work there, and pushes branches/PRs to the remote.

In addition to issue-driven runs, night-orch can run an explicit repo-idle `file-loop` maintenance session. That loop works in its own worktree, applies only low-risk trivial edits automatically, and accumulates non-trivial follow-ups in `loop.md` for review in a single PR.

Repo-local overrides are optional: if a repo contains `.night-orch.yml` (or `.night-orch.yaml`), those settings are deep-merged with the central config for that repo.

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
night-orch demo      # web UI against synthetic demo data (UI dev mode)
```

The daemon polls each configured repo for issues labeled `no:ready`, processes them through the AI pipeline, and creates PRs. It runs continuously until you stop it (Ctrl+C).

### Demo mode (UI iteration)

`night-orch demo` spins up the web UI against a self-contained, synthetic dataset. No real config, forge tokens, repos, or worker binaries are required — the command writes a throwaway config and SQLite DB to a temp directory, seeds varied demo runs / issues / events, and serves the REST + WebSocket API with auth and mutations disabled. Useful when iterating on the dashboard UI without running actual tasks.

```bash
night-orch demo --port 3250          # defaults: 127.0.0.1:3250
pnpm web:build && night-orch demo    # ensure the SPA bundle exists first
mise run demo                         # builds + runs, honors NIGHT_ORCH_DEMO_PORT
```

The temp directory is cleaned up on shutdown. Pass `--keep-temp-dir` to leave it behind for debugging.

### Remote web access + mobile

The web UI at `127.0.0.1:3200` is loopback-only by default. There
are three deployment shapes for remote access, in increasing order
of operator auth involvement:

On loopback, the daemon writes a one-time web token to
`$XDG_RUNTIME_DIR/night-orch-web.token` with mode `0600` and prints it
once on startup. Paste that token into the browser sign-in dialog; the
session response intentionally does not expose the token in JSON.

**Option 1 — Trust the reverse proxy (simplest; Caddy, Tailscale serve, nginx)**

If you're already running a trusted proxy in front of night-orch
(Caddy with basic-auth, Cloudflare Tunnel, Tailscale serve,
authenticated nginx), let it handle authentication and bypass
night-orch's own auth entirely:

```bash
# night-orch binds loopback only, the proxy reaches it locally.
night-orch web --host 127.0.0.1 --port 3200 --skip-auth
```

Then configure Caddy / Tailscale / nginx to forward to
`http://127.0.0.1:3200` with whatever auth model you already trust.
The `--skip-auth` flag disables the cookie+token check on the
mutation guard but keeps the intent-header and content-type guards
in place, so drive-by CSRF is still blocked.

**Option 2 — Tailscale only (trust the tailnet)**

Bind loopback, run `tailscale serve` as the forwarder, and every
device on your tailnet can reach the UI without any additional
auth:

```bash
tailscale serve --bg https / http://127.0.0.1:3200
night-orch web --host 127.0.0.1 --port 3200 --skip-auth
```

**Option 3 — Direct exposure with the built-in operator token**

If you don't have a proxy, bind to a non-loopback interface and
set an operator token:

```bash
export NIGHT_ORCH_WEB_AUTH_TOKEN=$(openssl rand -base64 24)
night-orch web --host 0.0.0.0 --port 3200 \
  --allowed-host myhost.example
```

On first visit the browser shows a sign-in dialog; paste the token
and the server replies with an `HttpOnly SameSite=Strict` session
cookie that lasts 8 hours. **The signing secret is regenerated on
every restart**, so a stolen cookie stops working as soon as the
daemon recycles. Mutating browser requests also use a double-submit
CSRF cookie/header pair; non-browser scripts can avoid cookie+CSRF
handling by sending the operator token as `x-night-orch-web-token`.

### Web Push notifications (overnight alerts to your phone)

For push notifications to phones that installed the web UI as a
PWA, add a `webpush` notification channel:

```yaml
notifications:
  channels:
    - type: webpush
      vapidPublicKeyEnv: NIGHT_ORCH_VAPID_PUBLIC
      vapidPrivateKeyEnv: NIGHT_ORCH_VAPID_PRIVATE
      vapidSubjectEnv: NIGHT_ORCH_VAPID_SUBJECT
```

Generate a VAPID keypair once with `npx web-push generate-vapid-keys`,
export the three env vars on the daemon host, then open Settings in
the web UI and click **Enable notifications**. Subsequent `blocked`,
`pr_ready`, `error`, and `retry_exhausted` events deliver as
background notifications even when the tab is closed.

### Running as a systemd service

A minimal service unit + environment file for a system-wide install:

**`/etc/systemd/system/night-orch.service`**

```ini
[Unit]
Description=night-orch autonomous agent orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=orch
Group=orch
WorkingDirectory=/home/orch
EnvironmentFile=/etc/night-orch/env
ExecStart=/usr/local/bin/night-orch serve \
  --web-host 127.0.0.1 --web-port 3200 \
  --skip-auth
Restart=on-failure
RestartSec=10

# Basic hardening — the daemon only needs to read config and
# write to its state/worktree directories.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/orch/.config/night-orch /home/orch/code/.night-orch

[Install]
WantedBy=multi-user.target
```

**`/etc/night-orch/env`** — mode `0600`, owned by `no:orch`.
Keeps secrets out of the service unit and out of `ps`.

```ini
# Forge auth (pick the one you use)
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# FORGEJO_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Web UI operator token (only needed when NOT using --skip-auth)
# NIGHT_ORCH_WEB_AUTH_TOKEN=base64url-random-24-bytes

# Phase 2c — Web Push VAPID keys (only when webpush channel is configured)
# NIGHT_ORCH_VAPID_PUBLIC=BN...
# NIGHT_ORCH_VAPID_PRIVATE=dW...
# NIGHT_ORCH_VAPID_SUBJECT=mailto:you@example.com

# Phase 3 — Direct-LLM API keys (only when ai.internal.provider is set)
# ANTHROPIC_API_KEY=sk-ant-api03-...
# OPENROUTER_API_KEY=sk-or-v1-...

# MCP HTTP server token (only when mcp.enabled: true AND bound non-loopback)
# NIGHT_ORCH_MCP_AUTH=xxxxxxxxxxxxxxxxxx

# Optional: tune log level
# LOG_LEVEL=info
```

**Commands**:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now night-orch
sudo systemctl status night-orch
journalctl -u night-orch -f
```

### Environment variables reference

All env vars night-orch reads, grouped by feature area:

| Var | Required when | Effect |
|---|---|---|
| `GITHUB_TOKEN` (or custom `tokenEnv`) | using GitHub forge | Forge auth. Blacklisted from CLI worker subprocesses. |
| `FORGEJO_TOKEN` (or custom) | using Forgejo forge | Forge auth. Blacklisted from CLI worker subprocesses. |
| `NIGHT_ORCH_WEB_AUTH_TOKEN` | binding web UI non-loopback without `--skip-auth` | Operator token for the login dialog. |
| `NIGHT_ORCH_MCP_AUTH` | `mcp.authTokenEnv` set | MCP HTTP server auth. |
| `NIGHT_ORCH_VAPID_PUBLIC` | `webpush` notification channel | Web Push VAPID public key. |
| `NIGHT_ORCH_VAPID_PRIVATE` | `webpush` notification channel | Web Push VAPID private key. Blacklisted from worker envs. |
| `NIGHT_ORCH_VAPID_SUBJECT` | `webpush` notification channel | `mailto:` URL for VAPID subject. |
| `ANTHROPIC_API_KEY` (or custom `apiKeyEnv`) | `ai.internal.provider: anthropic` with any `enable.*` flag on | Direct-LLM API key. Blacklisted from worker envs. |
| `OPENROUTER_API_KEY` (or custom) | `ai.internal.provider: openrouter` | Same. Blacklisted. |
| `NIGHT_ORCH_WEBHOOK_URL` (or custom `urlEnv`) | generic webhook notification channel | Blacklisted. |
| `LOG_LEVEL` | optional | pino log level (default `info`). |

**Security guarantees** (see `src/workers/env.ts`):

- Every variable matching `*TOKEN*`, `*SECRET*`, `*KEY*`, `*API_KEY*`, `*PASSWORD*`, `*AUTH*`, `*CREDENTIAL*` is blocked from reaching CLI worker subprocesses.
- Every variable prefixed `GITHUB_`, `FORGEJO_`, `GH_`, `ANTHROPIC_`, `OPENAI_`, `OPENROUTER_`, `NIGHT_ORCH_VAPID_` is blocked by prefix match.
- The worker env starts from an empty whitelist (`PATH`, `HOME`, `LANG`, `NODE_ENV`, `USER`, `TZ`, tool locations) and only adds explicit `workerProfile.env` overrides that survive the blacklist check.

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
- Issue actions on selected runs: retry, continue, rebase, and delete entry

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

1. **Discovery** — the daemon polls each repo for open issues with configured labels (default: `no:ready`)
2. **Triage** — issues are classified as trivial, standard, or architectural based on labels and body length
3. **Decomposition** (optional) — complex issues are split into independent sub-tasks
4. **Pipeline execution** — each issue runs through the configured workflow in an isolated git worktree (defaults: `standard` = Plan → Code → Verify → Review → Decide, `trivial` = Code → Verify → Decide)
5. **Publishing** — approved changes are committed, pushed, and a PR is created on the remote
6. **Merge queue** (optional) — approved PRs are batched, tested, and merged automatically

Planning-only override: if an issue also has the planning label (default `no:planning`), night-orch runs a planning-only workflow and publishes exactly one PRD markdown file (no code/test/config changes).

### Label lifecycle

```
no:ready → no:running → no:review-ready → (merged)
                  ↓                ↓
            no:blocked     no:merge-queued
                  ↓                ↓
            no:error       no:merge-failed
```

To retry a blocked or errored issue, remove the blocking label and add `no:ready`, or use:

```bash
night-orch retry owner/repo 42
```

---

## Workflows

By default, night-orch uses:

```
Standard:    Plan → Code → Verify → Review → Decide
Trivial:           Code → Verify → Decide
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
    workflowByTriage:
      trivial: minimal   # optional triage-specific routing
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

### DAG workflows

You can also define a workflow as an explicit DAG:

```yaml
workflows:
  dag-minimal:
    dag:
      entry: code
      stages:
        code:
          type: worker
          role: coder
          next: smoke
        smoke:
          type: verify
          profile: strict
          stage: smoke
          next: decide
        decide:
          type: decide
          onIterate: code
```

Rules:
- Define either `steps` or `dag` (not both)
- `worker`/`verify` DAG stages must set `next`
- DAG must terminate at a `decide` stage

### Step types

| Type | Purpose |
|------|---------|
| `worker` | Invoke an AI agent (planner, coder, reviewer, or custom role) |
| `verify` | Run configured verify commands (repo default or selected profile/stage) |
| `decide` | Evaluate results and route to publish, iterate, or block (`requireReview: false` supports no-review flows) |

### Step options

- `skipWhen: trivial` — skip this step for trivially-triaged issues
- `continueFrom: plan` — continue the AI session from a prior step when both steps use the same agent (reduces token usage, improves context)
- `prompt: path/to/template.md` — use a custom system prompt instead of the default
- `requireReview: false` — allow verification-only decisioning for lightweight workflows
- `profile: strict` + `stage: smoke` (verify step) — run a specific verification profile stage
- `roles` (workflow-level) — per-workflow default role assignment (`planner`/`coder`/`reviewer`)
- `agents` (workflow-level) — per-workflow worker profile overrides (same shape as `repos[].agents`)

### Staged verification profiles

```yaml
verificationProfiles:
  strict:
    stages:
      - id: smoke
        commands:
          - pnpm typecheck
      - id: full
        commands:
          - pnpm test
        required: false
        onFailure: warn

repos:
  - repo: org/repo
    verificationProfile: strict
```

Use `verificationProfile` on a repo as the default; per-step verify `profile`/`stage` can override it.

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
7. **Culprit found** — the single PR that broke CI is labeled `no:merge-failed`

### Flaky CI handling

With `retryFlakyOnce: true` (default), a failed batch is retried once before bisecting. This avoids unnecessary bisection due to flaky tests.

Manual retry is blocked while the PR is still part of an active merge-queue batch. Wait for the batch to pass/fail or remove the PR from the active batch before starting a fresh retry.

### Automatic rebase fan-out

Set `repos[].autoRebaseOnMerge.enabled: true` to queue rebase attempts for open sibling PRs after a tracked PR merges into the same base branch. The daemon detects merges during sync and merge-queue finalization, filters siblings by repo/base/open state, and records a `rebase_fanouts` marker so the same source PR is not fanned out twice.

Use `maxFanout` to cap how many siblings are queued from one merge. Use `maxChainLength` to cap follow-up attempts for these automatic rebase chains; when the cap is exhausted, night-orch skips that sibling and leaves a PR comment for manual review.

Fan-out records each sibling outcome (`queued`, `skipped`, or `failed`) and always records the source marker after the fan-out attempt, including partial failures. That prevents one failed sibling from replaying the whole fan-out on the next sync. Startup recovery logs a warning when prior fan-outs have failed sibling rows that need operator attention.

### Labels

- `no:merge-queued` — PR has entered the merge queue
- `no:merging` — PR's batch is currently being tested
- `no:merge-failed` — PR was identified as the bisection culprit

---

## Multi-Agent Support

Night-orch supports multiple AI agent backends. Each role (planner, coder, reviewer) can use a different agent.

### Built-in adapters

| Type | Agent | Notes |
|------|-------|-------|
| `claude` | Claude Code CLI | Default planner in the standard role split. Uses `--output-format json`, session continuity via `--continue` |
| `codex` | Codex CLI | Default coder/reviewer in the standard role split. Uses `--output-last-message`, session continuity via `--resume` |
| `acp` | Any ACP agent | Via [acpx](https://github.com/openclaw/acpx) — supports Gemini, Claude, Codex, and 17+ agents |

Role hardening for Codex runs is automatic: coder steps run with `--sandbox workspace-write`, while planner/reviewer steps run with `--sandbox read-only`.

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
- **Merge conflicts** — PR is no longer mergeable against base

### How it works

Each poll cycle scans `review_ready` PRs for new events. When a reaction is detected:

1. The reaction context (CI output, review comments) is stored on the run
2. The issue is transitioned back to `queued` with reaction context
3. On the next poll cycle, the next pass receives the reaction context and can address it

Merge-conflict reactions are treated differently from ordinary review follow-ups. Instead of dropping straight into a generic continue pass, night-orch now queues a dedicated branch refresh attempt that respects the repo's `updateStrategy` (`merge` or `rebase`). If that refresh conflicts, the run blocks with a durable conflict snapshot so the later `/orch continue` pass sees the actual files, SHAs, and excerpts that caused the conflict.

This happens automatically — no configuration needed beyond the standard setup. Reactions are identified by the content of the comment/review, not by its author, so feedback you post under the same GitHub identity that runs night-orch is still picked up. See [Single-user deployment](./single-user.md) for the details.

---

## Comment Commands

Night-orch responds to commands posted on the backing issue **or** on the PR. Accepted sources:

- Issue conversation comments
- PR review bodies (the top-level text submitted with the review)
- PR inline review comments (anchored to a file/line)

| Command | Action |
|---------|--------|
| `/orch retry` | Re-queue a blocked or errored issue |
| `/orch rebase` | Rebase the work branch onto the latest base |
| `/orch cancel` | Cancel an active run |
| `/orch continue` | Queue a context-aware second pass for blocked/review-ready/errored runs |

Once a run reaches `review_ready`, re-trigger it through `/orch continue`, `/orch retry`, or `/orch rebase`. Re-adding `no:ready` manually is treated as stale orchestration state and will be scrubbed on the next poll.

Night-orch distinguishes its own comments from yours via an HTML marker (`<!-- night-orch:… -->`), not by GitHub author, so `/orch` commands you post under the same identity that runs night-orch are still parsed. See [Single-user deployment](./single-user.md).

### Configuration

```yaml
commentCommands:
  enabled: true              # default: true
  requireCollaborator: true   # default: true; explicit false logs a warning each cycle
```

---

## CLI Reference

All commands can be run from any directory — night-orch reads its central config from `~/.config/night-orch/config.yaml` by default (or `--config <path>`), then applies optional per-repo `.night-orch.yml/.yaml` overrides from each `repos[].localPath`.

### `night-orch run`

Start the long-running poller daemon. Polls all configured repos on the configured interval, processes eligible issues, creates PRs. Also starts the embedded MCP HTTP/SSE server and Prometheus metrics endpoint.

Options: `--config`, `--trust-workspace`, `--dry-run`, `--log-level`, `--ndjson`

`--ndjson` emits one JSON object per line to stdout for each poll-cycle event (`poll_cycle_start`, `poll_cycle_result`, `poll_cycle_followup_scheduled`, `poll_cycle_error`).

### `night-orch web`

Start the embedded web control surface. Serves the React/Tailwind frontend, a REST API under `/api/*`, and a WebSocket stream endpoint at `/ws`.

By default, `web` runs in attach mode: no poll loop, no metrics server, and no embedded MCP server are started in the web process. Manual web operations (`poll`, `sync`, `cleanup`, `retry`, `continue`, `rebase`, `delete entry`, `labels-init`, runtime settings set/clear) remain available and execute in the web process. Queued issue actions also signal any running daemon that uses the same database so the next poll cycle starts without waiting for the regular interval. Attach mode logs an explicit reminder that metrics are expected from the `night-orch run` daemon, not from the web process.
Use `--standalone` to run poller + metrics + embedded MCP in the same process as the web server.
Dashboard-level quick actions for `refresh`, `poll`, `sync`, and `cleanup` are in the sticky header; each icon button shows a hover tooltip label to clarify the action, and the Issues-page Operations panel is reserved for Deploy controls.
Issue-specific actions (`retry`, `continue`, `rebase`, `delete entry`) are launched from each issue's detail page and require a confirmation dialog before execution. The detail page now includes a per-action strategy selector (`repo default`, `merge`, `rebase`) for manual retry/continue/rebase operations. Project labels initialization (`labels-init`) is launched from each project's detail page using the `Bootstrap Labels` action and also requires confirmation. `Delete entry` also supports a force toggle for active/shared-state cleanup scenarios.
Issue detail pages render line-oriented issue history rather than only the currently selected run's log. The stream keeps prior attempts visible after `continue`/`retry`, and manual actions are recorded as highlighted `user_action` entries alongside system and agent events.
The web client now keeps the websocket open across auth-token refreshes, uses heartbeat-based liveness detection, and reconnects with exponential backoff instead of a fixed 2-second loop.
On narrow mobile viewports, the top-line dashboard metric cards render in a compact 2-column layout so the runs list stays the primary focus on the Issues page.
The Issues page run list now includes history filters (`Active`, `Completed`, `Failed`, `All`) plus a `Load more` control for paginated archive browsing (20 runs per page).
The web API now exposes `GET /api/inbox` for operator triage queues (`needs_human`, `review_ready`, `blocked`, `error`), and `/api/dashboard` includes the same inbox snapshot for clients that consume one aggregate payload.

For mobile or server-hosted setups, use an external terminal client such as Terminus instead of expecting shell access through the browser UI.

Default bind is `127.0.0.1:3200`. Use `--host` / `--port` to change this (for example when reverse-proxying through Caddy or nginx). Use `--allowed-host` (repeatable) to permit additional Host/Origin values when proxying.

Options: `--config`, `--trust-workspace`, `--dry-run`, `--log-level`, `--host`, `--allowed-host`, `--port`, `--snapshot-interval-ms`, `--standalone`

### `night-orch run-once`

Execute a single poll cycle and exit. Useful for testing and CI.

Options: `--config`, `--trust-workspace`, `--dry-run`, `--log-level`, `--ndjson`

`--ndjson` emits one JSON object per line to stdout for run lifecycle events (`poll_start`, `poll_result`, `poll_error`).

### `night-orch init`

Interactive setup wizard. Guides you through creating a config file.

### `night-orch doctor`

Run diagnostic checks: config validity, environment variables, forge authentication, CLI binaries, repo paths, base branches, worktree root, database, verify commands, and a metrics endpoint probe (`/healthz`).

The metrics probe classifies common failures (`ok`, `not-ready`, `connection-refused`, `timeout`). If metrics are disabled by runtime override, doctor reports `disabled-runtime` as an optional check so accidental toggles stay visible without failing the full command.

Use `--project <owner/name>` to validate a specific target project's readiness: repo accessibility, base branch, forge auth, labels, worker profiles, and verify commands.

### `night-orch status`

Show current state: active runs, active leases, daily cost against budget, recent run history.

The metrics line includes a runtime-override annotation when effective `metrics.enabled` differs from YAML.

### `night-orch tui`

Live-updating terminal dashboard. Refreshes every 2 seconds. Shows active runs, merge queue, cost bar, recent history, issue actions (`poll`, `sync`, `cleanup`, `retry`, `continue`, `rebase`, `delete entry`), a Settings tab (`5`) for runtime overrides (read-only keys are listed but cannot be changed), and a File-Loop tab (`6`) for starting/stopping repo-scoped file-loop sessions. Press `m` on the Runs list to cycle the manual action strategy override (`default` → `merge` → `rebase`) used by retry/continue/rebase. On the File-Loop tab, use `f` to start a session for the selected repo and `x` to request stop. Press Ctrl+C to exit.

### `night-orch settings`

Manage DB-backed runtime overrides for all non-project-specific config keys. Read-only keys (for example `storage.dbPath`) are listed but cannot be overridden at runtime. Sensitive values are redacted in list output.

- `night-orch settings list [--json]`
- `night-orch settings set <key> <value>`
- `night-orch settings unset <key>`

JSON runtime settings require schema-valid structure; syntactically valid but malformed payloads are rejected.

### `night-orch sync`

Reconcile database state with GitHub: mark runs for merged PRs as completed, detect closed issues, correct label mismatches, find orphaned worktrees.

### `night-orch retry <repo> <issue>`

Start a fresh retry of a blocked or errored issue from the latest base branch. The existing worktree/branch state is discarded and night-orch rebuilds from the source branch tip.

Options: `--immediate` (process now instead of queuing), `--strategy merge|rebase` (override the repo default for this manual action). The legacy `--fresh` and `--reset-plan` flags are accepted for compatibility but have no additional effect. When a retry is queued without `--immediate`, night-orch also signals any running daemon that uses the same database so the next poll cycle starts promptly.

### `night-orch rebase <repo> <issue>`

Queue an explicit git rebase of the PR branch onto the latest base branch, then run verify commands to check if code adjustments are needed. This is the manual, force-the-update path; automatic PR merge-conflict reactions use the repo's normal branch refresh strategy instead. If verify fails after a successful rebase, the issue is automatically re-queued for the coder to fix. When `autoResolveConflicts.enabled` and `ai.internal.features.conflictResolver` are both on, night-orch attempts one bounded AI-assisted conflict resolution pass before blocking. If the resolver fails, the run falls back to the normal `merge_conflict` block path and waits for either `continue` or `retry`.

Options: `--strategy merge|rebase` (override the action strategy for this manual rebase request). `merge` merges the latest base branch into the work branch; `rebase` replays commits and is still the default behavior for explicit rebase runs. Successful queueing also signals any running daemon that uses the same database to wake for the next cycle immediately.

Also available as a comment command: `/orch rebase` (with `--check` by default).

Explicit rebase requests from CLI, TUI, web, MCP, and comment commands all use `loop.maxAttemptChainLength`. Comment-triggered rebases are recorded in issue history as `comment:<user>` user actions.

### `night-orch continue <repo> <issue>`

Queue a context-aware second pass for blocked/review-ready/errored work. Night-orch collects the latest PR context (review comments, CI failures, mergeability state) and resumes the existing branch with that context.

After a branch refresh, explicit rebase, or publish/push reconciliation conflicts, `/orch continue` keeps the current branch state and asks the agent to resolve the conflict. The follow-up prompt now includes the preserved conflict snapshot rather than only a lossy text summary. Use `/orch retry` instead when you want to discard the current branch state and restart from the latest base branch.

For review-ready issues, `continue`, `retry`, and `rebase` are the supported re-entry paths. Manually re-adding `no:ready` does not start another pass.

Options: `--strategy merge|rebase` (override the repo default for this manual action). This is most useful when resuming after a rebase conflict and you want the next manual update step to use a different strategy. Successful queueing also signals any running daemon that uses the same database to wake for the next cycle immediately.

Also available as a comment command: `/orch continue`.

### `night-orch file-loop <action>`

Manage repo-scoped file-loop sessions. Actions: `start`, `stop`, `status`.

Typical usage:

```bash
night-orch file-loop start --repo owner/repo
night-orch file-loop start --repo owner/repo --max-minutes 120
night-orch file-loop status
night-orch file-loop stop --repo owner/repo --wait
```

Behavior:

- A file-loop session only progresses while the repo has no active issue runs.
- Candidate files are filtered by `fileLoop.includeGlobs`, `fileLoop.excludeGlobs`, and `fileLoop.maxFileLines`.
- The reviewer profile classifies each file. Only `trivial` edits are applied automatically.
- Non-trivial follow-up work is appended to `loop.md` instead of being auto-edited.
- `stop --wait` blocks until the current session finalizes and, if there are commits, publishes its PR outcome.

Options:

- `--repo <owner/name>`: required when multiple repos are configured
- `--max-minutes <n>`: override the session duration for `start`
- `--wait`: for `stop`, wait until finalization completes

### `night-orch cleanup`

Remove stale worktrees, delete merged branches, archive old logs. Respects `storage.retention` settings.

### `night-orch labels-init [repo]`

Create or update orchestration labels on GitHub/Forgejo. Run this after initial setup or after adding new repos. Pass a repo slug to update a single repo, or omit for all configured repos.

### `night-orch notify-test`

Send a test notification through all configured channels. Verifies webhook/Discord URLs, SMTP credentials, etc.

### `night-orch mcp`

Start the MCP server on stdio transport (for Claude Code integration). Exposes 23 tools and 3 resources for querying and controlling night-orch.

### `night-orch monitoring`

Manage the external Prometheus + Grafana monitoring stack. Night-orch bundles Docker Compose configs, Prometheus scrape config, and a pre-built Grafana dashboard.

- `night-orch monitoring init [--dir <path>] [--force]` — extract bundled monitoring configs to `~/.config/night-orch/monitoring/` (or a custom directory). Use `--force` to overwrite existing files.
- `night-orch monitoring up [--dir <path>]` — start the monitoring stack (`docker compose up -d`)
- `night-orch monitoring down [--dir <path>]` — stop the monitoring stack (`docker compose down`)
- `night-orch monitoring logs [--dir <path>]` — tail monitoring stack logs

After running `monitoring init`, set `GRAFANA_ADMIN_PASSWORD` in your environment and run `monitoring up`. Grafana is available at `http://localhost:3001` by default.

---

## Cost Management

Night-orch tracks costs at two levels:

### Per-run budgets

```yaml
security:
  maxCostPerRunUsd: 10    # max cost per issue processing run
  maxDailyCostUsd: 50     # max total daily spend
```

When a budget is exceeded in `pay-per-use` mode, the run is blocked with
reason `cost_limit`. In `subscription` mode, USD is advisory and cost-based
blocking is skipped. In `subscription-metered` mode, enforcement depends on
`cost.subscriptionMetered.enforcePerRunLimit` / `enforceDailyLimit`.

### Non-cost runaway budgets

```yaml
loop:
  maxAttemptChainLength: 3    # hard cap on follow-up attempts per issue
  maxRunTokens: 0             # 0 disables per-run token guard
  maxIssueTokens: 0           # 0 disables per-issue cumulative token guard
  maxDailyTokens: 0           # 0 disables UTC-day token guard
  maxRunWallClockMinutes: 0   # 0 disables wall-clock guard
```

These controls are independent of USD accounting and are enforced in all cost
models. When tripped, the run is blocked with a specific message naming the
triggered guard (run/issue/daily tokens or wall-clock).

### Stuck-loop detection

Night-orch detects when the loop is stuck by comparing verify output hashes across iterations. If two consecutive iterations produce identical verify failures (same tests failing the same way, after stripping timestamps and non-deterministic output), the run is blocked with a specific "Loop stuck" message instead of consuming more iterations. This prevents the common case where the LLM keeps attempting the same fix without making progress.

### Cost model

```yaml
cost:
  model: pay-per-use   # or: subscription, subscription-metered
  # subscriptionMetered:
  #   advisoryThresholdUsd: 25
  #   enforcePerRunLimit: false
  #   enforceDailyLimit: false
  # pricing:
  #   defaultModel: claude-sonnet-4
  #   models:
  #     claude-sonnet-4:
  #       inputUsdPerMillionTokens: 3
  #       outputUsdPerMillionTokens: 15
  #       cacheReadUsdPerMillionTokens: 0.3
  #       minuteUsd: 0.008
```

- `pay-per-use` keeps USD spend as the primary dashboard metric and enforces `security.maxCostPerRunUsd` + `security.maxDailyCostUsd`.
- `subscription` keeps token usage as the primary dashboard metric and bypasses `cost_limit` enforcement (USD remains advisory-estimated using pricing config/defaults).
- `subscription-metered` tracks advisory USD like `subscription`, logs threshold warnings, and can optionally enforce run/day caps.
- `cost.pricing.models` optionally enables model-aware USD estimation keyed by `workerProfiles.<name>.pricingModel` (or worker `type` when unset).

### Cost estimation

- **Token-based** (preferred) — when the agent adapter reports token counts, cost is calculated from per-model input/output/cache-read token rates
- **Time-based** (fallback) — when token counts aren't available, cost is estimated from each model's `minuteUsd`

View costs/usage:
- `night-orch status` — shows daily cost summary (including cache-read tokens and phase cost breakdown)
- `night-orch watch` — live cost/usage summaries
- Prometheus metric: `night_orch_estimated_cost_dollars`

---

## Prometheus Metrics

When `metrics.enabled: true`, night-orch exposes metrics at `http://<host>:<port>/metrics` and health metadata at `http://<host>:<port>/healthz`. A ready-to-import Grafana dashboard lives at [`grafana/dashboard.json`](../grafana/dashboard.json) — it includes a dedicated "Architecture health — Phase 4 gate" row for the operator-health counters below.

Core run metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `night_orch_runs_total` | counter | Total runs by outcome (`completed` / `blocked` / `error`) |
| `night_orch_active_runs` | gauge | Currently active runs |
| `night_orch_eligible_issues` | gauge | Eligible issues per repo |
| `night_orch_queued_issues` | gauge | Issues queued but not yet dispatched |
| `night_orch_blocked_issues` | gauge | Blocked issues per repo |
| `night_orch_run_duration_seconds` | histogram | Run duration distribution |
| `night_orch_phase_duration_seconds` | histogram | Duration per loop phase |
| `night_orch_loop_iterations_total` | counter | Loop iterations per repo |
| `night_orch_agent_invocations_total` | counter | Agent calls by role and adapter |
| `night_orch_agent_duration_seconds` | histogram | Agent call duration (labels: role, adapter) |
| `night_orch_verify_runs_total` | counter | Verification pass/fail counts |
| `night_orch_verify_duration_seconds` | histogram | Verify command duration |
| `night_orch_pr_operations_total` | counter | PRs created/updated |
| `night_orch_notifications_total` | counter | Notification deliveries by channel + result |
| `night_orch_errors_total` | counter | Errors by repo + error_type |
| `night_orch_rebase_fanouts_total` | counter | Automatic fan-out events by repo and base branch |
| `night_orch_rebase_fanout_siblings_queued_total` | counter | Sibling PRs queued by automatic rebase fan-out |
| `night_orch_daily_cost_usd` | gauge | Today's spend |
| `night_orch_estimated_cost_dollars` | counter | Estimated cost rate per repo/agent |
| `night_orch_build_info{version,commit}` | gauge | Constant `1` build marker for scrape diagnostics |

Architecture health (Phase 4 gate) metrics — expose the stability
invariants from the immutable-attempts refactor. Alert if any of
these leave their healthy range:

| Metric | Type | Healthy | Description |
|--------|------|---------|-------------|
| `night_orch_cost_token_source_total{source}` | counter | `reported_cli` / `measured_api` dominate | Cost ledger rows grouped by provenance. Any `estimated_duration` or `fallback_zero` means cost figures are degraded-confidence — operator flipped `cost.allowEstimatedDuration` or a worker failed to report token usage. |
| `night_orch_checkpoint_quarantine_rows` | gauge | `0` | Count of rows in the `checkpoint_quarantine` table. Non-zero = phase_data corruption detected at crash recovery; inspect the row before clearing. |
| `night_orch_circuit_breaker_trips_total{repo}` | counter | `< 1/week` | Poller skipped an issue that hit `loop.maxConsecutiveBlocks` consecutive blocked runs. Rising rate = an issue is stuck in a retry loop. |

The web UI's Stats page also renders a "Architecture health" card with
the same four counters aggregated over the standard windows (14d for
cost fallbacks, 7d for consecutive blocks) so operators can check
the Phase 4 gate without Prometheus access.

---

## MCP Integration

Night-orch exposes an MCP server for integration with Claude Code and other MCP clients.

### Tools (23)

| Tool | Description |
|------|-------------|
| `night-orch-list-settings` | List runtime settings, overrides, and effective values (sensitive fields redacted) |
| `night-orch-set-setting` | Set one DB-backed runtime override |
| `night-orch-clear-setting` | Clear one DB-backed runtime override |
| `night-orch-status` | Operational snapshot |
| `night-orch-run-detail` | Full run history and events |
| `night-orch-list-runs` | Filtered run listing |
| `night-orch-cost-report` | Daily cost breakdown |
| `night-orch-retry` | Re-run an issue |
| `night-orch-cost-override` | Grant a per-run budget override to the latest run for an issue |
| `night-orch-daily-cost-override` | Raise today's daily budget cap |
| `night-orch-cost-reset` | Reset the latest run's accumulated cost and resume cost-blocked work |
| `night-orch-daily-cost-reset` | Reset today's accumulated daily cost counters |
| `night-orch-continue` | Queue a context-aware second pass |
| `night-orch-sync` | Reconcile DB with GitHub |
| `night-orch-cleanup` | Remove stale resources |
| `night-orch-labels-init` | Create/update orchestration labels for a repo |
| `night-orch-delete-entry` | Delete local issue state |
| `night-orch-poll` | Trigger single poll cycle |
| `night-orch-list-issues` | List eligible/active issues |
| `night-orch-stream-events` | Stream recent agent events |
| `night-orch-rebase` | Queue rebase + re-evaluate |
| `night-orch-update` | Trigger self-update |
| `night-orch-file-loop` | Start, stop, or inspect repo-scoped file-loop sessions |

### Usage

```bash
# Standalone MCP server (stdio)
night-orch mcp

# Embedded in daemon (HTTP/SSE)
night-orch run  # MCP server starts automatically on configured port
```
