# Night-Orch: Architecture Overview

Night-orch is an autonomous orchestrator that watches GitHub/Forgejo repositories for eligible issues, dispatches AI coding agents (Claude Code, Codex) to plan, implement, and review changes, then publishes the result as a pull request. It also supports an explicit repo-idle `file-loop` maintenance mode for low-risk cleanup passes outside issue-driven work. It runs as a long-lived poller, manages concurrent work via leases, tracks state in SQLite, and enforces strict security isolation between the orchestrator (which holds forge tokens) and the AI workers (which never see them).

---

## End-to-End: What Happens When an Issue is Processed

This walkthrough follows a single issue from discovery to PR. Read this first to ground yourself before diving into subsystems.

1. **Poll** — The runner (`src/runner/poller.ts`) wakes up on an interval and calls the forge API to list open issues matching configured label selectors. If a repo has an active file-loop session, the same poll cycle also gives that session a chance to advance even when no issues were discovered.

2. **Triage** — Each issue is classified as `trivial`, `standard`, or `architectural` based on labels and body length (`src/discovery/triage.ts`). Architectural issues are labeled for humans and skipped. Trivial issues get shorter timeouts.

3. **Lease** — Before processing, the poller acquires a lease in SQLite (`src/state/leases.ts`). This prevents two poller instances from working the same issue. If the lease is already held, the issue is skipped.

4. **Role Resolution** — Issue labels like `code:codex` or `review:claude` override the repo's default worker assignments (`src/discovery/roles.ts`).

5. **Worktree Setup** — A git worktree is created (or reused) for the issue's branch (`src/git/worktree.ts`). The base branch is merged in to prevent stale code.

6. **Environment Setup** — Shared or dedicated environment is configured (`src/environment/`). Dedicated mode spins up a Docker Compose stack. Port allocation and `.env` file generation happen here.

7. **Loop Engine** — The core cycle begins (`src/loop/engine.ts`):
   - **Plan** — A planner agent decomposes the issue into steps.
   - **Code** — A coder agent implements the plan in the worktree.
   - **Verify** — Shell commands (tests, lint, typecheck) run against the worktree.
   - **Review** — A reviewer agent critiques the changes.
   - **Decide** — A pure function examines accumulated context and returns: `publish`, `iterate`, `block`, or `error`.
   - If `iterate`, the loop repeats from Code with review feedback folded in.

8. **Publish** — On `publish` decision, the branch is pushed and a PR is created/updated via the forge adapter (`src/publishing/`). Labels transition to `review_ready`, and that finalize step scrubs the other orchestration labels so the issue does not re-enter discovery until a real follow-up control action is queued.

9. **Notify** — Configured channels (console, webhook, Discord, SMTP, GitHub comment) receive event notifications (`src/notify/`).

10. **Cleanup** — The lease is released in a `finally` block. On error or block, labels are updated and a comment is posted.

> **Watch out:** The loop engine never mutates `RunContext`. Every phase returns a _new_ context object. If you accidentally mutate the context, checkpointing and crash recovery will break silently because the DB snapshot won't match the in-memory state.

---

## Data Flow

```
CLI Commands (commander)
    │
    ▼
Config (YAML → Zod validation → expanded paths)
    │
    ▼
Runner / Poller ──────────────────────────────────────┐
    │                                                  │
    ▼                                                  │
Discovery                                             │
  ├─ Forge API (list issues)                          │
  ├─ Triage (classify complexity)                     │
  └─ Role Resolution (label overrides)                │
    │                                                  │
    ▼                                                  │
Lease Manager (SQLite) ◄─────────────────────────────┐│
    │                                                 ││
    ▼                                                 ││
Git (worktree create/reuse, branch, merge base)       ││
    │                                                 ││
    ▼                                                 ││
Environment (shared validate / dedicated Docker)      ││
    │                                                 ││
    ▼                                                 ││
Loop Engine ◄──────────────── Checkpoints (SQLite)    ││
  ├─ Plan   → Worker (Claude/Codex CLI)               ││
  ├─ Code   → Worker (Claude/Codex CLI)               ││
  ├─ Verify → Shell commands (test/lint/typecheck)    ││
  ├─ Review → Worker (Claude/Codex CLI)               ││
  └─ Decide → Pure function (no I/O)                  ││
    │                                                 ││
    ├─ iterate ──────────────────────────► (back to Code)
    │                                                 ││
    ▼                                                 ││
Publishing (git push → forge PR create/update)        ││
    │                                                 ││
    ▼                                                 ││
Labels (idempotent state transitions)                 ││
    │                                                 ││
    ▼                                                 ││
Notifications (parallel dispatch to channels)         ││
    │                                                 ││
    ▼                                                 ││
Lease Release ────────────────────────────────────────┘│
Metrics (best-effort Prometheus) ◄─────────────────────┘
```

---

## Subsystems

### CLI (`src/cli/`)
Core commands built with `commander`: `run` (long-running poller), `run-once` (single cycle), `doctor` (validate setup), `sync` (reconcile state with forge), `retry` (fresh restart from latest base), `continue` (resume existing branch with fresh PR context), `rebase` (explicit rebase and re-evaluate), `cleanup` (remove stale artifacts), `notify-test` (test channels), and `mcp` (start MCP server). Global flags: `--config`, `--trust-workspace`, `--dry-run`, `--log-level`.

### Config (`src/config/`)
YAML config validated by Zod schemas (`schema.ts`). The loader (`loader.ts`) reads central config, merges optional per-repo `.night-orch.yml/.yaml` overrides from each `repos[].localPath` (project wins), validates the merged result, and expands paths (`~` → home dir, `{auto:3000-4000}` → allocated port). Key files: `schema.ts` (types + validation), `loader.ts` (load + merge + expand).

> **Watch out:** Zod's `noUncheckedIndexedAccess` means every field accessed via bracket notation might be `undefined`. You'll see a lot of `if (!item) throw ...` guard patterns — these aren't paranoia, they're required by the compiler.

### Forge (`src/forge/`)
Abstraction layer over GitHub and Forgejo APIs. `types.ts` defines the `ForgeAdapter` interface; `github.ts` and `forgejo.ts` implement it. `factory.ts` selects the right adapter based on repo config. Tokens are read at adapter creation and never stored in config or context.

- The GitHub adapter uses Octokit's throttle and retry plugins to absorb transient 429/5xx responses. Primary rate-limit retries are capped at two attempts; secondary rate limits are retried and logged.

> **Watch out:** All forge API calls must go through `ForgeAdapter`. Direct Octokit usage outside `forge/github.ts` is forbidden — it bypasses auth handling and breaks the Forgejo abstraction.

### Discovery (`src/discovery/`)
Three responsibilities: fetch eligible issues from the forge (`discover.ts`), classify complexity via triage (`triage.ts`), and resolve per-issue worker roles from labels (`roles.ts`). Triage adjusts loop limits — trivial issues get half the iterations and timeout.

### Git (`src/git/`)
All git operations use `execa` (not `simple-git`). `worktree.ts` provides `ensure()` (create or reuse worktree with either fresh-reset or preserve-branch semantics), `remove()`, and `list()`. `slug.ts` generates and pins branch slugs in the DB so they survive issue title changes. `repo.ts` handles branch operations.

> **Watch out:** automatic base updates and explicit `/orch rebase` are separate flows. Normal retries rebuild from the latest base branch, merge-conflict reactions queue a dedicated branch refresh using the repo's `updateStrategy`, continues preserve the existing branch state, and explicit rebase captures conflict context for a later continue/retry decision. Any refresh/rebase conflict now blocks immediately with a durable conflict snapshot instead of relying on a lossy summary.

### Environment (`src/environment/`)
Two modes: **shared** (validate existing services are running) and **dedicated** (spin up a Docker Compose stack per issue). `port.ts` allocates ports from configured ranges. `env-file.ts` generates `.env` files with marked override sections. `bootstrap.ts` runs setup commands.

### Workers (`src/workers/`)
AI agents invoked as CLI subprocesses. `claude.ts` and `codex.ts` implement the `WorkerAdapter` interface. Prompt compilation (`prompt/compiler.ts`) assembles templates with runtime context and sanitizes untrusted issue content. Output parsing (`parsers/`) validates JSON responses with Zod.

Workers run through Sandcastle. Each worker profile can use the strict host sandbox or a Docker/Podman sandbox. Container sandboxes are configured per profile so reliability can be compared per agent while keeping host execution available as a fallback.

> **Watch out:** `env.ts` is a critical security file. It implements a whitelist+blacklist system that strips all tokens, secrets, and forge credentials from the worker's environment. If you add a new env var to workers, it must pass both the whitelist and the blacklist check.

### Loop Engine (`src/loop/`)
The heart of the system. Covered in detail below.

### File Loop (`src/fileloop/`)
Repo-idle maintenance engine for explicit `file-loop` sessions. The session store and file-state store live in SQLite, candidate selection filters files by glob and size, the reviewer worker classifies each candidate, only `trivial` edits are applied automatically, and deferred work is appended to `loop.md`. Publication reuses the normal forge adapter path, but final verification can choose between opening a draft PR or suppressing PR creation on failure.

### Publishing (`src/publishing/`)
Pushes branches and creates/updates PRs via the forge adapter. Compiles PR title and body from context. On failure, transitions labels to error and posts a comment.

### Labels (`src/labels/`)
`computeLabelMutation()` is a pure function that computes which labels to add/remove for a given status transition. `transitionLabels()` applies mutations via the forge, with best-effort error handling (logs warnings, doesn't throw).

### Notifications (`src/notify/`)
Multi-channel dispatcher. Channels (console, webhook, Discord, SMTP, GitHub comment, Web Push) run in parallel via `Promise.allSettled()`. Event config controls which events trigger notifications. Missing env vars silently skip channels. The `webpush` channel sends VAPID-signed push notifications to any browser that subscribed through the web UI's Settings page and prunes expired endpoints on HTTP `410 Gone`.

### Mentions (`src/mentions/`)
Posts configured mentions to PRs. Deduplication is commit-specific (tracked in SQLite). Labels like `pr-mention:slack` configure per-issue mentions.

### Metrics (`src/metrics/`)
Prometheus metrics via `prom-client`. `createMetricsService()` returns either a live service or a no-op. All metric calls are wrapped in try-catch — metrics never block or throw. HTTP endpoint serves `/metrics` (Prometheus format) and `/api/stats` (JSON).

### MCP Server (`src/mcp/`)
Model Context Protocol interface for external agents. Twenty-three tools — see [USAGE.md → MCP Integration](./USAGE.md#mcp-integration) for the full list. Three resources (status, config, metrics). Mutation tools require the auth token from `mcp.authTokenEnv` when configured. Transport: `stdio` for the standalone `night-orch mcp` command; HTTP/SSE when embedded in the `run` daemon (host/port from `mcp.httpHost` / `mcp.httpPort`). Run-event streaming exposes one ordered log across system and agent events.

### Poller (`src/poller/`)
The R6 decomposition of the old `src/runner/poller.ts` god object. `discovery-scheduler.ts` picks eligible issues each cycle. `reaction-processor.ts` turns forge events (comment commands, label changes, PR reactions) into typed control commands. `attempt-dispatcher.ts` holds the lease, inserts a new `attempts` row, runs the loop engine, and finalizes. `error-recovery.ts` classifies typed worker errors and decides retry vs. block. `notify-dispatcher.ts` maps attempt events to notification payloads.

### AI (`src/ai/`)
Phase 3 direct-LLM client layer for night-orch's **own** internal AI tasks — triage refinement, reviewer parse salvage, PR body generation, and the bounded rebase-conflict resolver. `anthropic.ts` (Messages API) and `openrouter.ts` (OpenAI-compat) are thin fetch wrappers with Zod-validated structured output. Most consumers gate on `ai.internal.enable.*`; the conflict resolver is additionally gated by `autoResolveConflicts.enabled` and `ai.internal.features.conflictResolver`. Token usage feeds the same cost ledger as CLI workers, tagged `token_source='measured_api'`. Code-editing roles (planner/coder/reviewer) **stay on the CLI path** — they rely on the agentic tool-use loop that direct APIs don't provide.

### Ops (`src/ops/`)
Maintenance engines: `sync.ts` reconciles local state with forge (finds orphaned attempts, fixes label mismatches), `cleanup.ts` removes stale worktrees and archives old logs, `retry.ts` starts fresh retries from latest base (inserts a new attempt), `continue.ts` gathers fresh PR context and resumes the existing branch (inserts a new attempt), `rebase-and-check.ts` manages explicit rebase flows plus post-rebase verification, and `fanout-rebase.ts` queues automatic sibling rebase attempts after a tracked PR merges through sync or the merge queue. Automatic merge-conflict reactions now enqueue a distinct refresh attempt that uses the repo's `updateStrategy`, and `continue.ts` preserves the resulting conflict snapshot across attempts so later coder prompts can see the original files, excerpts, and branch/base SHAs. On textual rebase conflicts, `rebase.ts` now collects full conflict sources, optionally runs one bounded AI-assisted resolution pass, validates the returned file content, and only then continues the rebase; unresolved cases still abort back to the canonical `merge_conflict` block path.

### State (`src/state/`)
SQLite with WAL mode via `better-sqlite3`. `db.ts` handles init and migrations. `attempts.ts` manages the **immutable** attempts ledger (see below): every `retry`/`continue`/`rebase` inserts a new row chained to the previous one via `previous_attempt_id`, and terminated attempts are never mutated afterward. `rebase-fanouts.ts` records per-source-PR fan-out markers plus per-sibling outcomes for idempotent automatic sibling rebases. `runs.ts` preserves the legacy per-row update surface for callers that still query by run id. `leases.ts` provides atomic lease acquisition via `INSERT OR IGNORE`. `stats.ts` powers the Web/TUI dashboards.

### Web (`src/web/`)
HTTP/SSE server serving the Web UI and programmatic API for operators. `server.ts` binds the routes (`/api/status`, `/api/operations/*`, `/api/settings`, `/api/stats`, `/api/cost/health`, `/api/events` SSE). `auth.ts` provides stateless HMAC-signed session cookies (`norch_session`) plus double-submit CSRF cookies for browser mutations; loopback mode stores the generated web token in a `0600` sidecar file instead of exposing it from `/api/session`. `--skip-auth` remains available for deployments behind a trusted reverse proxy (Caddy, Tailscale serve). `webpush.ts` wires the VAPID-signed Web Push delivery used by the `webpush` notification channel. The frontend is in the top-level `web/` package (Vite + React + Tailwind). Shared DaisyUI component contracts live in `src/components/` and are previewed/documented in Storybook (`pnpm storybook`).

### Utils (`src/utils/`)
`logger.ts` — pino logger with token redaction. `ids.ts` — nanoid-based run IDs. `command.ts` — shell command parsing with quoting support.

---

## The Loop Engine in Detail

The loop (`src/loop/engine.ts`) orchestrates four phases in a cycle:

```
Plan ──► Code ──► Verify ──► Review ──► Decide
                    ▲                      │
                    │    iterate            │
                    └──────────────────────┘
```

### RunContext (`src/loop/types.ts`)

The central data structure. Immutable — every phase receives it and returns a new one with accumulated results:

```typescript
// Conceptual shape (simplified)
interface RunContext {
  readonly issue: Issue;
  readonly repoConfig: RepoConfig;
  readonly roles: ResolvedRoles;
  readonly triage: TriageResult;
  readonly plan?: PlannerOutput;       // set after Plan phase
  readonly codeResult?: CoderOutput;   // set after Code phase
  readonly verifyResults?: VerifyResult[]; // set after Verify phase
  readonly reviewResults?: Record<string, ReviewerOutput>; // keyed by reviewer step/slot
  readonly reviewFindings?: ReviewFinding[]; // merged reviewer findings for coder retries
  readonly iterationCount: number;
  readonly cost: CostAccumulator;
}
```

### Phases

- **Plan** — Sends issue + context to the planner worker. Output: structured plan with steps. Skipped for trivial issues.
- **Code** — Sends plan + review feedback to the coder worker. The coder works in the git worktree.
- **Verify** — Runs configured shell commands (e.g., `pnpm test`, `pnpm lint`). Each command's exit code and output are captured.
- **Review** — Sends the diff to one or more reviewer workers. Output: verdict (`APPROVED`, `CHANGES_REQUIRED`, `BLOCKED`) with comments, stored by reviewer step/slot and merged for coder retries.

### Decision (`src/loop/decision.ts`)

A **pure function** with no side effects. This is critical for testability and crash recovery:

```
decide(ctx: RunContext) → LoopDecision
```

Every decision wraps a `RunState` (`src/loop/state.ts`) discriminated union — `running`, `publishing`, `published`, `blocked { reason }`, or `error`. The `blocked.reason` sub-union (`costLimit`, `iterationLimit`, `agentPassLimit`, `reviewerBlocked`, `ambiguousReview`, `verifyConfig`, `mergeConflict`, `authFailure`, `emptyDiff`, `workerTimeout`, `tokenCaptureFailed`) gives compile-time exhaustiveness via `assertNever` at every consumer (status comments, label transitions, finalizer, web snapshot).

Rules (in priority order):
1. Cost over budget → `blocked { costLimit }`
2. Max agent passes exceeded → `blocked { agentPassLimit }`
3. Empty diff + no review findings → `iterate` (R3, bounded by `loop.maxEmptyDiffRetries`)
4. Aggregate review verdict `APPROVED` + verify pass → `publish`
5. Aggregate review verdict `APPROVED` + verify fail → `iterate` (tests broke, try again)
6. Any `CHANGES_REQUIRED` reviewer under iteration limit → `iterate`
7. Any `CHANGES_REQUIRED` reviewer at max iterations → `blocked { iterationLimit }`
8. Any `BLOCKED` reviewer → `blocked { reviewerBlocked }`
9. Parse failure → `blocked { ambiguousReview }` or `iterate` (configurable)

> **Watch out:** `decide()` must never do I/O, read the DB, or call APIs. If you need new information for a decision, add it to `RunContext` in a prior phase. Putting side effects in `decide()` breaks crash recovery because the function may be re-executed after a checkpoint restore.

---

## Failure & Recovery

### Phase Checkpointing (`src/loop/checkpoint.ts`)

Every phase writes two records to SQLite:
- `phase_start` — before the phase begins
- `phase_complete` (or `phase_failed`) — after it ends, including artifacts (plan output, code result, etc.)

On crash, `resumeFromCheckpoint()` reads the last completed phase from the DB and reconstructs a `RunContext` from stored artifacts. The loop resumes from the next phase.

> **Watch out:** Checkpoints store phase artifacts, not the full `RunContext`. The context is reconstructed from artifacts. If you add a new field to `RunContext` that's needed for recovery, you must also persist it in the checkpoint.

### Leases (`src/state/leases.ts`)

Leases prevent duplicate processing. Acquired atomically via `INSERT OR IGNORE` (no race conditions). Released in `finally` blocks. Stale leases (>30 min without heartbeat) are cleaned by the sync engine.

### Retry (`src/ops/retry.ts`)

Requeues a failed or blocked run: resets status to `queued`, clears error data, releases any lease, updates labels. Optional `immediate: true` triggers a synchronous `pollOnce()`.

### Sync (`src/ops/sync.ts`)

Reconciliation engine that runs on startup and via CLI. Detects: runs marked "running" with no active lease, label mismatches between DB and forge, orphaned worktrees on disk with no matching run.

---

## State & Ownership

All persistent state lives in SQLite (WAL mode). Here's what each table tracks and who uses it:

| Entity | Written by | Read by | Purpose |
|--------|-----------|---------|---------|
| `attempts` (formerly `runs`) | AttemptDispatcher, Loop Engine | Poller, Ops, Web, MCP, CLI | **Immutable per-attempt lifecycle** (queued → running → completed/blocked/error). Retry/continue/rebase/refresh INSERT new rows chained via `previous_attempt_id`. |
| `run_cost_entries` | Cost Recorder | Cost Query, Web, MCP | Append-only cost ledger with `token_source` provenance (`reported_cli`, `measured_api`, `estimated_duration`, `fallback_zero`). |
| `checkpoints` | Loop Engine | Loop Engine (resume) | Phase artifacts for crash recovery, validated by Zod (R5). |
| `checkpoint_quarantine` | Loop Engine | Operator, metrics | Rows rejected by the Zod validator — non-zero count is a Phase 4 gate alert. |
| `leases` | AttemptDispatcher | Poller (skip check), Ops (cleanup) | Prevent duplicate processing. |
| `web_sessions` (deprecated) | — | — | Predecessor to stateless session cookies. New installs leave this empty. |
| `push_subscriptions` | Web auth | WebPush channel | VAPID push targets for the `webpush` notification channel. |
| `slugs` | Git module | Git module | Immutable branch-name slugs. |
| `rebase_fanouts` | Sync, Merge Queue | Ops, Retention | Idempotency markers for automatic sibling rebase fan-out after a source PR merges. |
| `mentions` | Mention Tracker | Mention Tracker | Per-commit dedup of PR mentions. |
| `migrations` | DB init | DB init | Track applied schema migrations. |

The single biggest data-model rule: **terminated attempts are read-only**. Setting `terminated_at` is a one-way latch. Retry/continue/rebase/refresh never mutate a prior attempt — they insert a new one with a fresh cost ledger and a `previous_attempt_id` pointer. This eliminates the entire "reset-counters" bug class that drove multiple FIX commits pre-Phase-1.

> **Watch out:** All SQL queries use parameterized statements (`?` placeholders). String interpolation in SQL is forbidden — it's a security vulnerability and a linting failure.

---

## Security & Trust Boundaries

Night-orch has a hard security boundary between the **orchestrator** (trusted, holds tokens) and **workers** (untrusted, attacker-influenced via issue content).

### Token Isolation
- The orchestrator holds `GITHUB_TOKEN` / `FORGEJO_TOKEN` for API access.
- Workers **never** receive these tokens. `buildWorkerEnv()` in `src/workers/env.ts` applies a strict whitelist (PATH, HOME, LANG, NODE_ENV) and a blacklist pattern (`*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, `GITHUB_*`, `FORGEJO_*`).
- Worker sandbox env goes through the same blacklist before being passed to Docker/Podman providers. Subscription CLI auth must be provided by explicit config-directory mounts, not by passing API keys into the container.
- If you add a new env var to workers, you must update `ENV_WHITELIST` and verify it passes the blacklist.

### Prompt Injection Defense
- Issue titles and bodies are **attacker-controlled** (any GitHub user can create an issue).
- `sanitizeIssueBody()` in `src/workers/prompt/compiler.ts` strips HTML tags, code fences, and excessive whitespace before injecting into prompts.
- Raw issue content is never interpolated into system prompts.
- Worker outputs are validated by Zod parsers before the orchestrator acts on them.

### Logging
- pino redaction strips `*.token`, `*.apiKey`, `*.secret`, `*.password`, `headers.authorization` from all log output.
- Full API request/response bodies are never logged — only status codes and summaries.

---

## Invariants You Must Not Break

These are hard rules enforced across the codebase. Breaking them causes subtle bugs, security holes, or crash-recovery failures.

1. **Never mutate `RunContext`** — Always create a new object: `{ ...ctx, field: value }`. Mutation breaks checkpointing.

2. **All forge calls go through `ForgeAdapter`** — Never import or call Octokit directly outside `forge/github.ts`.

3. **`decide()` is pure** — No I/O, no DB, no API calls. Side effects here break crash recovery.

4. **Workers never see tokens** — All worker env goes through `buildWorkerEnv()`. Adding env vars requires whitelist update.

5. **Labels are idempotent** — Use `computeLabelMutation()` (pure) then apply. Never add/remove labels directly.

6. **Metrics never throw** — All metric calls are wrapped in try-catch. A metrics failure must never block the loop.

7. **SQL is parameterized** — No string interpolation in queries. Ever.

8. **ESM imports use `.js` extension** — Even for `.ts` files. This is required by the ESM module system.

9. **Node builtins use `node:` prefix** — `import { readFile } from 'node:fs/promises'`, not `'fs/promises'`.

10. **No `any` type** — Use `unknown` and narrow with type guards. The compiler enforces this.

11. **Leases are released in `finally`** — A leaked lease blocks the issue for 30+ minutes until stale cleanup runs.

12. **Checkpoints persist artifacts** — If you add a field to `RunContext` needed for recovery, persist it in the checkpoint too.

---

## Recommended Reading Order

Start with the core loop to understand what night-orch does, then expand outward:

### Foundation (start here)
1. `src/loop/types.ts` — RunContext and phase definitions. Everything revolves around this.
2. `src/loop/engine.ts` — The orchestration loop. Read this to understand the phase sequence.
3. `src/loop/decision.ts` — The pure decision function. Small file, critical logic.
4. `src/config/schema.ts` — What can be configured. Gives you the vocabulary.

### Workers & Prompts
5. `src/workers/types.ts` — Worker input/output contracts.
6. `src/workers/prompt/compiler.ts` — How prompts are assembled and sanitized.
7. `src/workers/env.ts` — Token isolation (security-critical).

### Forge & Discovery
8. `src/forge/types.ts` — The ForgeAdapter interface.
9. `src/discovery/discover.ts` — How issues are selected.
10. `src/discovery/triage.ts` — Complexity classification.

### State & Orchestration
11. `src/state/db.ts` — Database setup and migrations.
12. `src/state/leases.ts` — Lease acquisition (atomic INSERT OR IGNORE pattern).
13. `src/runner/poller.ts` — The main orchestration loop that ties everything together.

### Supporting Systems (as needed)
- `src/publishing/` — PR creation
- `src/labels/transitions.ts` — Label state machine
- `src/environment/manager.ts` — Shared vs dedicated environments
- `src/ops/sync.ts` — State reconciliation
- `src/notify/dispatcher.ts` — Notification routing
