# Night-Orch Configuration Guide

This document explains how to write `night-orch` configuration files.

Source of truth for the schema is [src/config/schema.ts](../src/config/schema.ts). If this document and the code differ, treat the schema as authoritative and update this document.

## Config File Discovery

`night-orch` resolves config in this order:

1. `--config <path>` (if provided)
2. `.night-orch.yaml` (only when `--trust-workspace` is set)
3. `.night-orch.yml` (only when `--trust-workspace` is set)
4. `config.yaml`
5. `config.yml`
6. `~/.night-orch/config.yaml`
7. `~/.night-orch/config.yml`
8. `~/.config/night-orch/config.yaml`
9. `~/.config/night-orch/config.yml`

Recommended deployment uses a dedicated non-root user (for example `orch`) with:
- config/state in `/home/orch/.night-orch/`
- code in `/home/orch/apps/night-orch`
- target repos in `/home/orch/repos/*`

## Runtime Settings Overrides (DB-backed)

Night-orch supports a curated set of runtime overrides stored in SQLite (`settings_overrides` table).  
Effective config precedence is:

1. YAML value (or schema default when omitted)
2. DB override (if present)

Overrides are persisted in DB and survive process restarts. They are not written back to YAML.

Curated runtime keys:

| Key | Type | Accepted Range |
| --- | --- | --- |
| `github.pollIntervalSeconds` | integer | `5..3600` |
| `security.maxDailyCostUsd` | number | `1..10000` |
| `security.maxCostPerRunUsd` | number | `0.1..1000` |
| `loop.maxReviewIterations` | integer | `1..20` |
| `loop.maxTotalAgentPasses` | integer | `1..50` |
| `observability.agentStreaming` | boolean | `true`/`false` |

Update surfaces:

- CLI: `night-orch settings list|set|unset`
- MCP: `night-orch-list-settings`, `night-orch-set-setting`, `night-orch-clear-setting`
- Web: Settings page (`/api/settings`, `/api/operations/settings/*`)
- TUI: `settings` tab (hotkey `5`)

## YAML Conventions

- `version` must be exactly `1`.
- `tokenEnv` values are env var names, not literal tokens.
- Path expansion (`~`, `$VAR`, `${VAR}`) is applied to:
  - the config file path
  - `storage.dbPath`
  - `storage.worktreeRoot`
  - `storage.logsRoot`
  - `repos[].localPath`
- `CommandSpec` fields accept either:
  - string: `"pnpm test -- --run"`
  - array: `["pnpm", "test", "--", "--run"]`
- `repos[].labels.ready` and `repos[].labels.blocked` accept either string or string array and are normalized to arrays.

## Timestamp & Timezone Semantics

- Night-orch treats all timestamps as UTC.
- Runtime-generated timestamps use ISO-8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`).
- Legacy SQLite-style timestamps without an explicit timezone (for example `YYYY-MM-DD HH:mm:ss`) are interpreted as UTC.
- CLI/TUI time displays include an explicit `UTC` label.

## Top-Level Schema

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `version` | `1` | yes | none | Schema version. |
| `github` | object | yes | none | Global forge/auth settings. |
| `storage` | object | no | object with defaults | DB/worktree/log paths. |
| `notifications` | object | no | object with defaults | Channel/event notification config. |
| `loop` | object | no | object with defaults | Loop decision limits and behavior. |
| `security` | object | no | object with defaults | Diff/cost safety limits. |
| `cost` | object | no | object with defaults | Cost display model (`pay-per-use` or `subscription`). |
| `workerProfiles` | record | no | `{}` | Named CLI profiles for agents. |
| `metrics` | object | no | object with defaults | Prometheus exporter config. |
| `observability` | object | no | object with defaults | Live agent event streaming/persistence settings. |
| `mcp` | object | no | object with defaults | MCP server config for run/mcp commands. |
| `commentCommands` | object | no | object with defaults | Issue comment command processing config. |
| `repos` | array | yes | none | At least one repo is required. |
| `workflows` | record | no | `{}` | Named workflow definitions for custom pipelines. |

## `github`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `tokenEnv` | string | yes | none | Env var name holding GitHub token. Literal token prefixes (`ghp_`, `ghs_`, `github_pat_`) are rejected. |
| `apiBaseUrl` | URL string | no | `https://api.github.com` | Default base URL for GitHub repos. |
| `pollIntervalSeconds` | positive number | no | `300` | Poll interval used by `run` loop. |
| `appMentions` | record | no | `{}` | Mention templates keyed by mention alias (`claude`, `codex`, etc.). |

### `github.appMentions.<key>`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | no | `false` | If false, that mention key is filtered out even if requested by labels/defaults. |
| `commentTemplate` | string | yes | none | Template used when posting mention comments; supports `{issue}`, `{pr}`, `{repo}` placeholders. |

## `storage`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `dbPath` | string path | no | `~/.config/night-orch/state.db` |  |
| `worktreeRoot` | string path | no | `~/code/.night-orch/worktrees` | night-orch exports `MISE_TRUSTED_CONFIG_PATHS` with this path at startup, so any `.mise.toml` / `mise.toml` / `.tool-versions` checked out inside a worktree is automatically trusted by mise. Required for repos whose toolchain is managed by mise — otherwise bootstrap commands that invoke mise-shimmed tools (`bundle`, `node`, `rake`, ...) fail with "Config files ... are not trusted". |
| `logsRoot` | string path | no | `~/code/.night-orch/logs` |  |
| `autoCleanup` | object | no | object with defaults | Automatic cleanup settings. |
| `retention` | object | no | object with defaults | Data retention periods. |

### `storage.autoCleanup`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable automatic cleanup of stale worktrees and logs. |
| `intervalMinutes` | positive number | `60` | How often auto-cleanup runs (in minutes). |

### `storage.retention`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `worktreeAgeDays` | positive number | `7` | Remove completed/error worktrees older than this. |
| `detailDays` | positive number | `30` | Retain detailed run data (events, phase data) for this many days. |
| `archiveDays` | positive number | `90` | Archive run records older than this. |

## `notifications`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `channels` | array | no | `[ { type: "console" } ]` | Multiple channels allowed. |
| `events` | object | no | object with defaults | Per-event toggle switches. |

### `notifications.channels[]`

Discriminated by `type`:

- `console`
  - `type: "console"`
- `webhook`
  - `type: "webhook"`
  - `urlEnv: string` (env var name containing webhook URL)
- `smtp`
  - `type: "smtp"`
  - `host: string`
  - `port: positive int` (default `587`)
  - `from: string`
  - `to: string`
  - `userEnv: string` (env var name)
  - `passEnv: string` (env var name)

### `notifications.events`

| Key | Type | Default |
| --- | --- | --- |
| `onRunStarted` | boolean | `false` |
| `onBlocked` | boolean | `true` |
| `onPrReady` | boolean | `true` |
| `onError` | boolean | `true` |
| `onRetryExhausted` | boolean | `true` |

## `loop`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxReviewIterations` | positive number | `4` | Base max loop iterations before stop. |
| `maxTotalAgentPasses` | positive number | `10` | Base max total worker passes. |
| `stopOnPlannerFailure` | boolean | `true` | If planner output fails, stop early instead of continuing. |
| `requireVerificationPass` | boolean | `true` | If true, verification failures block completion. |
| `reviewApprovalKeyword` | string | `APPROVED` | Expected reviewer verdict keyword. |
| `reviewNeedsChangesKeyword` | string | `CHANGES_REQUIRED` | Expected reviewer verdict keyword. |
| `blockOnAmbiguousReview` | boolean | `true` | Parse failures in review phase become blocked state. |
| `maxAutoRetries` | int >= 0 | `3` | Auto-retry count for infrastructure errors. |
| `decompose` | boolean | `false` | Enable automatic issue decomposition into sub-tasks. |
| `maxSubtasks` | int 1-10 | `5` | Maximum sub-tasks per decomposition. |
| `maxConcurrentSubtasks` | int 1-10 | `3` | Max parallel sub-task worktrees. |

Note: loop limits are later triage-adjusted per issue (trivial/standard/architectural), so these are base values.

### Decomposition

When `decompose: true`, issues classified as `standard` triage level with a body exceeding 500 characters (or containing 3+ numbered items/headings) are sent to the planner for decomposition. The planner decides whether to split the issue and outputs 2-5 atomic sub-tasks. Each sub-task runs the full Plan→Code→Verify→Review loop in its own git worktree. Sub-tasks execute in parallel waves based on their dependency graph, up to `maxConcurrentSubtasks` concurrent worktrees.

## `security`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxChangedFiles` | positive number | `50` | Diff guard threshold. |
| `maxChangedLines` | positive number | `5000` | Diff guard threshold. |
| `maxDailyCostUsd` | positive number | `50` | Daily budget cap used by decision logic. |
| `maxCostPerRunUsd` | positive number | `10` | Per-run budget cap used by decision logic. |

### Unblocking a run hit by a cost cap

When a run is blocked by a cost limit, there are three escape hatches — pick
whichever matches the scope of the situation:

1. **Whole day over budget** → raise today's cap with
   `night-orch daily-cost-override <amount>`. Scoped to the current UTC day;
   auto-expires at 00:00 UTC. Use this when multiple queued issues would
   otherwise need individual overrides. Clear early with
   `night-orch daily-cost-override --clear`. Also exposed via MCP
   (`night-orch-daily-cost-override`) and TUI (`%` hotkey — doubles the
   current cap).
2. **One expensive run stuck** → grant a per-run override with
   `night-orch cost-override <repo> <issue> <amount>`. Replaces the per-run
   cap for that one run *and* exempts it from the daily cap. Use when a
   single heavyweight issue needs more headroom than the daily cap would
   normally permit.
3. **Permanently raise the cap** → `night-orch settings set
   security.maxDailyCostUsd <amount>` (or `security.maxCostPerRunUsd`). This
   persists until explicitly cleared with `night-orch settings unset`, so
   reserve it for deliberate budget increases — not incident response.

## `cost`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `model` | `pay-per-use` or `subscription` | `pay-per-use` | Controls whether dashboards emphasize USD or token usage while still tracking both. |

## `workerProfiles`

`workerProfiles` is a map of profile name to profile config.

Example:

```yaml
workerProfiles:
  claude-default:
    type: claude
    command: claude
    args: ["-p"]
```

### `workerProfiles.<name>`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `type` | string | yes | none | Adapter type. Built-in: `claude`, `codex`, `acp`. |
| `command` | string | yes | none | Binary to execute. |
| `args` | string[] | no | `[]` | Base CLI args for every task invocation. |
| `workerTimeoutSeconds` | positive number | no | `1800` | Base timeout before triage scaling. |
| `minimalEnv` | boolean | no | `true` | Deprecated/ignored; worker env is always whitelist-based. |
| `runtimeWrapper` | string or `null` | no | `null` | Wrapper command prepended before `command` (for sandbox wrappers, etc.). |
| `env` | record string->string | no | `{}` | Extra env vars for worker process; blacklist still applies. |

Worker `PATH` is normalized at runtime: if missing, `~/.local/bin`, `~/.local/share/pnpm`,
`~/.local/share/mise/shims`, `/usr/local/bin`, `/usr/bin`, and `/bin` are appended.

`repos[].agents` references these profile names. Unknown profile references fail config load.

### ACP Adapter

The `acp` adapter type uses the [Agent Client Protocol](https://github.com/openclaw/acpx) for agent-agnostic communication:

```yaml
workerProfiles:
  gemini-acp:
    type: acp
    command: gemini     # acpx agent name
    args: []
    workerTimeoutSeconds: 1800
```

The `command` field specifies the acpx agent name (e.g., `codex`, `claude`, `gemini`, `pi`). ACPX resolves this to the correct ACP adapter. Supported agents include any ACP-compatible agent registered with acpx.

Requires `acpx` installed as a dependency (`pnpm add acpx`).

## `metrics`

| Key | Type | Default |
| --- | --- | --- |
| `enabled` | boolean | `true` |
| `port` | positive int | `9090` |
| `host` | string | `0.0.0.0` |

## `observability`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `agentStreaming` | boolean | `true` | Enable live worker event emission and persistence. |
| `eventRetention` | int (100-10000) | `1000` | In-memory max agent events retained per run. |
| `sessionLogs` | boolean | `true` | Write per-phase JSONL session logs to `storage.logsRoot/<runId>/`. |
| `sessionLogRetention` | positive int | `7` | Retention target in days for session logs (consumed by cleanup policy). |

## `mcp`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | When true, `run` starts embedded HTTP/SSE MCP server. |
| `transport` | `stdio` | `stdio` | Current schema only allows `stdio`. |
| `authTokenEnv` | string or `null` | `null` | If set, mutating MCP tools require matching `authToken` argument. |
| `httpPort` | positive int | `3100` | Host/port used by embedded HTTP/SSE server started by `run`. |
| `httpHost` | string | `127.0.0.1` | Host bind for embedded HTTP/SSE server. |

## `commentCommands`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable processing of `/orch` commands in issue comments. |
| `requireCollaborator` | boolean | `false` | If true, only repo collaborators can use comment commands. |

Supported commands (posted as issue comments):
- `/orch retry` — re-queue a blocked/errored issue
- `/orch rebase` — rebase the work branch onto the latest base
- `/orch cancel` — cancel an active run
- `/orch continue` — queue a context-aware second pass for blocked/review-ready/errored runs

## `workflows`

Named workflow definitions for custom execution pipelines.
When no workflow is configured:
- `standard` issues use Plan→Code→Verify→Review→Decide
- `trivial` issues use a lightweight Code→Verify→Decide flow (review gate disabled)

```yaml
workflows:
  minimal:
    steps:
      - { type: worker, id: code, role: coder }
      - { type: verify, id: verify }
      - { type: worker, id: review, role: reviewer }
      - { type: decide, id: decide, onIterate: code }

  fast-trivial:
    roles:
      coder: codex
      reviewer: codex
    agents:
      codex: codex-fast
    steps:
      - { type: worker, id: code, role: coder }
      - { type: verify, id: verify }
      - { type: decide, id: decide, onIterate: code, requireReview: false }

  with-security:
    steps:
      - { type: worker, id: plan, role: planner, skipWhen: trivial }
      - { type: worker, id: code, role: coder, continueFrom: plan }
      - { type: verify, id: verify }
      - { type: worker, id: security, role: reviewer, prompt: security-review.md }
      - { type: worker, id: review, role: reviewer }
      - { type: decide, id: decide, onIterate: code }
```

### Step Types

| Type | Fields | Description |
| --- | --- | --- |
| `worker` | `id`, `role`, `skipWhen?`, `continueFrom?`, `prompt?` | Invoke a worker adapter. Built-in roles: `planner`, `coder`, `reviewer`. |
| `verify` | `id`, `skipWhen?` | Run configured verify commands. |
| `decide` | `id`, `onIterate`, `requireReview?` | Evaluate review/verify results and route to publish, iterate (jump to `onIterate` step), or block. |

- `skipWhen` — skip the step when the triage level matches (e.g., `trivial`)
- `continueFrom` — continue the AI session from a prior step (e.g., coder continues planner's session). Session reuse is agent-specific; cross-agent handoffs (for example `planner=claude`, `coder=codex`) start a fresh session.
- `prompt` — path to a custom system prompt template (overrides the default)
- `requireReview` — default `true`; set to `false` for no-review workflows (for example lightweight triage paths)

### Workflow-Level Overrides

- `roles` — optional role defaults (`planner`/`coder`/`reviewer`) for runs using this workflow
- `agents` — optional per-agent worker profile overrides (same shape as `repos[].agents`)

Reference a workflow in `repos[].workflow` by name.

## `repos[]`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `repo` | `owner/name` string | yes | none | Repository slug. |
| `forge` | `github` or `forgejo` | no | `github` | Forge implementation selector. |
| `linkedProjects` | `owner/name` string[] | no | `[]` | Additional issue-source repos to discover from using this repo's selectors/flow. |
| `apiBaseUrl` | URL string | no | none | Required for `forgejo`; optional override for `github`. |
| `tokenEnv` | string | no | none | Token env override per repo. |
| `maxConcurrentRuns` | int 1-20 | no | `1` | Max issues processed concurrently for this repo per poll cycle. |
| `localPath` | string path | yes | none | Local repo checkout path. |
| `baseBranch` | string | no | `main` | PR target branch. |
| `branchPrefix` | string | no | `orch` | Work branch prefix. |
| `labels` | object | no | object with defaults | Orchestration label names. |
| `kanban` | object | no | none | Optional alternate state-label flow activated by a trigger label. |
| `labelConfig` | record | no | `{}` | Label metadata overrides for `labels-init`. |
| `defaults` | object | no | object with defaults | Default roles + mention settings. |
| `planning` | object | no | object with defaults | Planning-only mode settings (PRD path). |
| `environment` | object | no | none | Shared/dedicated env setup. |
| `verify` | `CommandSpec[]` | no | `[]` | Verify commands run in worktree. |
| `prompts` | object | no | none | Optional custom system prompt template paths. |
| `selectors` | object | no | object with defaults | Issue label inclusion/exclusion filters. |
| `agents` | record | no | `{}` | Maps agent names to worker profile names. |
| `workflow` | string | no | none | Name of a workflow from `workflows` section. Uses default pipeline if omitted. |
| `workflowByTriage` | object | no | none | Per-triage workflow selection (`trivial`/`standard`). |
| `mergeQueue` | object | no | object with defaults | Merge queue configuration. |

Poll execution model:
- Repos are polled in parallel.
- Each repo runs up to `maxConcurrentRuns` issues at once (default `1`).

### `repos[].workflowByTriage`

Route triage levels to different named workflows:

```yaml
repos:
  - repo: myorg/myrepo
    workflow: full
    workflowByTriage:
      trivial: fast-trivial
      standard: full
```

Resolution order:
1. Planning-label workflow override (planning-only mode)
2. `workflowByTriage[triageLevel]`
3. `workflow`
4. Built-in defaults (`trivial` -> lightweight, others -> full)

Note: `architectural` issues are intentionally handled outside workflow execution and are labeled for human guidance.

### `repos[].labels`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `ready` | string or string[] | `['orch:ready']` | Normalized to array. |
| `running` | string | `orch:running` |  |
| `blocked` | string or string[] | `orch:blocked` | Normalized to array. |
| `needsHuman` | string | `orch:needs-human` |  |
| `reviewReady` | string | `orch:review-ready` |  |
| `error` | string | `orch:error` |  |
| `retry` | string | `orch:retry` |  |
| `planning` | string | `orch:planning` | When present on an issue, night-orch switches to planning-only mode and publishes only a PRD markdown file. |
| `mergeQueued` | string | `orch:merge-queued` | Set when PR enters the merge queue. |
| `merging` | string | `orch:merging` | Set while staging branch CI is running. |
| `mergeFailed` | string | `orch:merge-failed` | Set when the merge queue identifies this PR as the culprit. |

### `repos[].linkedProjects`

List of additional repositories to use as issue sources for the repo.

Example:

```yaml
repos:
  - repo: myorg/app
    linkedProjects:
      - myorg/tracker
      - myorg/platform-triage
```

Each entry must use `owner/name` format.

### `repos[].kanban`

Optional alternate state flow. When `triggerLabel` is present on an issue, night-orch uses `kanban.labels` for status transitions (queued/running/blocked/review/error/retry) instead of `repos[].labels`.

```yaml
repos:
  - repo: myorg/myrepo
    kanban:
      triggerLabel: flow:kanban
      labels:
        ready: [kanban:todo]
        running: kanban:doing
        blocked: kanban:blocked
        needsHuman: kanban:needs-human
        reviewReady: kanban:review
        error: kanban:error
        retry: kanban:retry
        planning: kanban:planning
        mergeQueued: kanban:merge-queued
        merging: kanban:merging
        mergeFailed: kanban:merge-failed
```

### `repos[].labelConfig`

Map of label name to optional metadata used by `night-orch labels-init`.

Each entry supports:

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `color` | 6-char hex string | no | Example: `0E8A16`. |
| `description` | string (<= 100 chars) | no |  |

Constraint: each entry must include at least one of `color` or `description`.

### `repos[].defaults`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `planner` | `claude` or `codex` | `claude` | Default planner role assignment. |
| `coder` | `claude` or `codex` | `claude` | Default coder role assignment. |
| `reviewer` | `claude` or `codex` | `claude` | Default reviewer role assignment. |
| `doneMode` | `pr-ready` or `manual-only` | `pr-ready` | Reserved for workflow policy; currently not consumed in runtime logic. |
| `notifyPriority` | `normal` or `high` | `normal` | Reserved for notification priority; currently not consumed in notifier routing. |
| `prMentions` | string[] | `[]` | Mention aliases posted on PRs by default. |

Role labels can override these defaults per issue:

- `plan:claude` / `plan:codex`
- `code:claude` / `code:codex`
- `review:claude` / `review:codex`

Planning-only mode label:

- `orch:planning` (or whatever `repos[].labels.planning` is set to)

When this label is present, night-orch uses a planning-only workflow and must produce a PR containing exactly one PRD markdown file.

### `repos[].planning`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `prdDirectory` | string | `docs/prd` | Repository-relative directory where planning-mode PRD files are created. |

### `repos[].environment`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `defaultMode` | `shared` or `dedicated` | no | `shared` | Base env mode. |
| `dedicated` | object | no | none | Required if dedicated mode is used. |
| `shared` | object | no | none | Shared mode behavior. |
| `bootstrap` | command object[] | no | `[]` | Runs during setup (`always`/`shared`/`dedicated`). |
| `cleanup` | command object[] | no | `[]` | Runs during dedicated teardown. |

Issue labels can force mode per run:

- `env:shared`
- `env:dedicated`

#### `repos[].environment.dedicated`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `compose.file` | string | yes | none | Compose file path used in worktree. |
| `compose.services` | string[] | no | `[]` | Optional service subset. |
| `compose.projectName` | string | no | `orch-{issue}` | `{issue}` placeholder supported. |
| `env.copyFrom` | string | no | `.env` | Base env file copied from repo root. |
| `env.overrides` | record | no | `{}` | Values support `{issue}` and `{auto:min-max}` port token. |
| `env.overrideFiles` | string[] | no | `[]` | Additional env files appended in order. |
| `healthcheck` | `CommandSpec` | no | none | Supports `{port}` placeholder after auto-port allocation. |
| `teardownOnComplete` | boolean | no | `true` | If true, compose stack is stopped after run. |

#### `repos[].environment.shared`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `requireRunning` | boolean | `true` | If true, failed healthcheck aborts run. |
| `healthcheck` | `CommandSpec` | none | Command to verify shared stack is up. |

#### `repos[].environment.bootstrap[]` and `cleanup[]`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `command` | `CommandSpec` | yes | none | Executed in worktree directory. |
| `when` | `always` \| `shared` \| `dedicated` | no | `always` | Mode filter. |

### `repos[].verify`

Array of commands executed sequentially in worktree. Failures are collected per command; verification result is evaluated after all commands run.

### `repos[].prompts`

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `plannerSystem` | string path | no | If file exists, used instead of default planner system prompt. |
| `coderSystem` | string path | no | If file exists, used instead of default coder system prompt. |
| `reviewerSystem` | string path | no | If file exists, used instead of default reviewer system prompt. |

If a configured template file is missing, a warning is logged and built-in defaults are used.

### `repos[].selectors`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `includeLabelsAny` | string[] | `['orch:ready']` | Issue must include at least one (empty list means include all). |
| `excludeLabelsAny` | string[] | `['orch:blocked', 'orch:error', 'orch:needs-human']` | Issue is skipped if any label matches. |

### `repos[].agents`

Map of agent name to worker profile name.

Typical shape:

```yaml
agents:
  claude: claude-default
  codex: codex-default
```

Resolution behavior:

1. If mapping exists and profile exists, that profile is used.
2. Otherwise, night-orch falls back to first profile whose `type` matches the role agent (`claude`/`codex`).
3. If no matching profile exists, the run fails.

### `repos[].mergeQueue`

Bors-style merge queue that batches approved PRs, tests them together, and bisects on failure.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Enable the merge queue for this repo. |
| `batchSize` | int 1-20 | `5` | Max PRs per batch. |
| `mergeMethod` | `merge` \| `squash` \| `rebase` | `merge` | Git merge strategy for staging branch. |
| `retryFlakyOnce` | boolean | `true` | Retry a failed batch once before bisecting. |
| `requireApproval` | boolean | `true` | Require human PR approval before entering queue. |
| `stagingBranchPrefix` | string | `orch/staging` | Prefix for staging branches. |

When enabled, each poll cycle:
1. Checks for an active staging batch — if CI passed, fast-forwards base branch
2. If CI failed, bisects the batch (halves it, tests each half) until the culprit PR is identified
3. If no active batch, scans for eligible PRs (review_ready + CI passing + approved) and forms a new batch
4. Conflicting PRs are ejected from the batch and continue to the next eligible PR

Labels used: `orch:merge-queued`, `orch:merging`, `orch:merge-failed`.

## Forge-Specific Notes

- `forge: github`
  - token env: `repos[].tokenEnv` if present, otherwise `github.tokenEnv`
  - API base URL: `repos[].apiBaseUrl` if present, otherwise `github.apiBaseUrl`
- `forge: forgejo`
  - token env: `repos[].tokenEnv` if present, otherwise `FORGEJO_TOKEN`
  - `repos[].apiBaseUrl` is required

## Mention Behavior

Mentions posted to PR comments are resolved from:

1. issue labels: `pr-mention:<key>`
2. repo defaults: `repos[].defaults.prMentions`
3. global gating: `github.appMentions.<key>.enabled` (disabled entries are removed)

Comment body is `github.appMentions.<key>.commentTemplate` if configured, otherwise `@<key>`.

## Examples

- Full example config: [examples/config.example.yaml](../examples/config.example.yaml)
- Local project sample used by this repo: [config.yaml](../config.yaml)
