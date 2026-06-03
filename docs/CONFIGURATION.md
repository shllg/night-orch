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

## Per-Repo Project Config (`.night-orch.yml`)

After the central config is loaded, night-orch checks each configured `repos[].localPath` for:

1. `.night-orch.yml`
2. `.night-orch.yaml`

If both files exist in the same repo, config load fails (ambiguous source).

Project config is deep-merged into central config with **project values winning**:

- Repo-scoped keys merge into that repo entry only.
- `workflows`, `workerProfiles`, and `verificationProfiles` merge into top-level maps.
- Objects merge recursively.
- Arrays are replaced (not concatenated).

Project files are intended for repo-scoped settings and project-owned workflow/profile definitions.

## Runtime Settings Overrides (DB-backed)

Night-orch supports DB-backed runtime overrides stored in SQLite (`settings_overrides` table).  
Effective config precedence is:

1. YAML value from central config, merged with per-repo project config (project wins where present)
2. DB override (if present; applies only to runtime-overridable non-repo keys)

Overrides are persisted in DB and survive process restarts. They are not written back to YAML.

Runtime settings registry scope:

- Includes all non-project-specific config keys used at runtime.
- Excludes project-scoped `repos[*]` settings and schema marker `version`.
- `storage.dbPath` is listed for visibility but is read-only at runtime (DB bootstraps before overrides load).
- Sensitive fields are redacted in settings read surfaces (for example `workerProfiles.*.env` values).
- JSON setting overrides are schema-validated per key before persistence.

Registered keys are visible via `night-orch settings list` (or Web/TUI Settings/MCP `night-orch-list-settings`). Current key groups:

- `github`: `tokenEnv`, `apiBaseUrl`, `pollIntervalSeconds`, `pollConcurrency`, `appMentions`
- `storage`: `dbPath` (read-only), `worktreeRoot`, `logsRoot`, `autoCleanup.enabled`, `autoCleanup.intervalMinutes`, `retention.worktreeAgeDays`, `retention.detailDays`, `retention.archiveDays`
- `notifications`: `channels`, `events.onRunStarted`, `events.onBlocked`, `events.onPrReady`, `events.onPrUpdated`, `events.onError`, `events.onRetryExhausted`
- `loop`: `maxReviewIterations`, `maxTotalAgentPasses`, `maxAttemptChainLength`, `maxRunTokens`, `maxIssueTokens`, `maxDailyTokens`, `maxRunWallClockMinutes`, `stopOnPlannerFailure`, `requireVerificationPass`, `reviewApprovalKeyword`, `reviewNeedsChangesKeyword`, `blockOnAmbiguousReview`, `maxAutoRetries`, `maxEmptyDiffRetries`, `maxConsecutiveBlocks`, `decompose`, `maxSubtasks`, `maxConcurrentSubtasks`
- `security`: `maxChangedFiles`, `maxChangedLines`, `maxDailyCostUsd`, `maxCostPerRunUsd`
- `cost`: `model`, `subscriptionMetered`, `pricing.defaultModel`, `pricing.models`
- `workerProfiles`
- `verificationProfiles`
- `metrics`: `enabled`, `port`, `host`
- `observability`: `agentStreaming`, `eventRetention`, `sessionLogs`, `sessionLogRetention`, `recordPromptCompilations`
- `mcp`: `enabled`, `transport`, `authTokenEnv`, `httpPort`, `httpHost`
- `commentCommands`: `enabled`, `requireCollaborator`, `acceptMentions`, `mentionAliases`, `reviewBotAllowlist`
- `workflows`

Keys **not** in the runtime registry — edit YAML and restart the daemon: `ai.*`, `fileLoop.*`, `cost.allowEstimatedDuration`, all `repos[]` settings, `github.tokenEnv` environment values (the registry exposes the env var *name*, not the token itself). Use `night-orch daily-cost-override` / `night-orch cost-override` for budget headroom rather than mutating `security.maxDailyCostUsd` at runtime.

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
- Project config files (`repos[].localPath/.night-orch.yml` or `.yaml`) may define repo-scoped keys plus optional top-level `workflows`, `workerProfiles`, and `verificationProfiles`.

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
| `fileLoop` | object | no | object with defaults | Repo-idle maintenance loop for low-risk file cleanup and review. |
| `security` | object | no | object with defaults | Diff/cost safety limits. |
| `cost` | object | no | object with defaults | Cost model (`pay-per-use` enforces USD caps; `subscription` is advisory-only; `subscription-metered` tracks advisory USD with optional enforcement). |
| `workerProfiles` | record | no | `{}` | Named CLI profiles for agents. |
| `metrics` | object | no | object with defaults | Prometheus exporter config. |
| `observability` | object | no | object with defaults | Live agent event streaming/persistence settings. |
| `mcp` | object | no | object with defaults | MCP server config for run/mcp commands. |
| `web` | object | no | object with defaults | Web UI security and proxy config. |
| `commentCommands` | object | no | object with defaults | Issue comment command processing config. |
| `repos` | array | yes | none | At least one repo is required. |
| `workflows` | record | no | `{}` | Named workflow definitions for custom pipelines. |
| `verificationProfiles` | record | no | `{}` | Named staged verification pipelines reusable across repos/workflows. |

## `github`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `tokenEnv` | string | yes | none | Env var name holding GitHub token. Literal token prefixes (`ghp_`, `ghs_`, `github_pat_`) are rejected. |
| `apiBaseUrl` | URL string | no | `https://api.github.com` | Default base URL for GitHub repos. |
| `pollIntervalSeconds` | positive number | no | `300` | Poll interval used by `run` loop. |
| `pollConcurrency` | positive integer | no | `4` | Number of repos polled in parallel per cycle. Valid range: `1`-`32`. |
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
- `discord`
  - `type: "discord"`
  - `urlEnv: string` (env var name containing Discord webhook URL)
- `smtp`
  - `type: "smtp"`
  - `host: string`
  - `port: positive int` (default `587`)
  - `from: string`
  - `to: string`
  - `userEnv: string` (env var name)
  - `passEnv: string` (env var name)
- `webpush` (Phase 2c — Web Push notifications to subscribed browsers)
  - `type: "webpush"`
  - `vapidPublicKeyEnv: string` (env var name, public VAPID key)
  - `vapidPrivateKeyEnv: string` (env var name, private VAPID key)
  - `vapidSubjectEnv: string` (env var name, e.g. `mailto:you@example.com`)
  - Generate a keypair once with `npx web-push generate-vapid-keys`,
    export the three env vars on the daemon host, and the web UI's
    Settings page will expose an "Enable notifications" button. Any
    browser that subscribes receives background push notifications
    for configured events (blocked, pr_ready, error, retry_exhausted
    by default). Subscriptions are persisted in
    `push_subscriptions` and pruned automatically on `410 Gone`.

### `notifications.events`

| Key | Type | Default |
| --- | --- | --- |
| `onRunStarted` | boolean | `false` |
| `onBlocked` | boolean | `true` |
| `onPrReady` | boolean | `true` |
| `onPrUpdated` | boolean | `true` |
| `onError` | boolean | `true` |
| `onRetryExhausted` | boolean | `true` |

## `loop`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxReviewIterations` | positive number | `4` | Base max loop iterations before stop. |
| `maxTotalAgentPasses` | positive number | `10` | Base max total worker passes. |
| `maxAttemptChainLength` | int 1-20 | `3` | Hard cap on follow-up attempts per issue chain (`retry`/`continue`/`rebase`/`refresh`). Manual rebase entry points (CLI, TUI, web, MCP, and comment commands) all use this cap. |
| `maxRunTokens` | int >= 0 | `0` | Non-cost runaway guard. Blocks when a single attempt reaches this total token count. |
| `maxIssueTokens` | int >= 0 | `0` | Non-cost runaway guard. Blocks when cumulative tokens across attempts for the same issue reach this count. |
| `maxDailyTokens` | int >= 0 | `0` | Non-cost runaway guard. Blocks when UTC-day cumulative tokens across all runs reach this count. |
| `maxRunWallClockMinutes` | number >= 0 | `0` | Non-cost runaway guard. Blocks when elapsed wall-clock time for one run reaches this many minutes. |
| `stopOnPlannerFailure` | boolean | `true` | If planner output fails, stop early instead of continuing. |
| `requireVerificationPass` | boolean | `true` | If true, verification failures block completion. |
| `reviewApprovalKeyword` | string | `APPROVED` | Expected reviewer verdict keyword. |
| `reviewNeedsChangesKeyword` | string | `CHANGES_REQUIRED` | Expected reviewer verdict keyword. |
| `blockOnAmbiguousReview` | boolean | `true` | Parse failures in review phase become blocked state. |
| `maxAutoRetries` | int >= 0 | `3` | Auto-retry count for infrastructure errors. |
| `maxEmptyDiffRetries` | int 0-5 | `2` | Auto-retry count when coder produces no file changes. |
| `maxConsecutiveBlocks` | int 1-20 | `4` | Circuit breaker: stop retrying after this many consecutive blocked runs on the same issue. |
| `decompose` | boolean | `false` | Enable automatic issue decomposition into sub-tasks. |
| `maxSubtasks` | int 1-10 | `5` | Maximum sub-tasks per decomposition. |
| `maxConcurrentSubtasks` | int 1-10 | `3` | Max parallel sub-task worktrees. |

`maxRunTokens`, `maxIssueTokens`, `maxDailyTokens`, and `maxRunWallClockMinutes` are disabled when set to `0`.

Note: loop limits are later triage-adjusted per issue (trivial/standard/architectural), so these are base values.

### Decomposition

When `decompose: true`, issues classified as `standard` triage level with a body exceeding 500 characters (or containing 3+ numbered items/headings) are sent to the planner for decomposition. The planner decides whether to split the issue and outputs 2-5 atomic sub-tasks. Each sub-task runs the full Plan→Code→Verify→Review loop in its own git worktree. Sub-tasks execute in parallel waves based on their dependency graph, up to `maxConcurrentSubtasks` concurrent worktrees.

## `fileLoop`

`fileLoop` configures a repo-scoped maintenance loop that runs only while the repo is otherwise idle. A session iterates through candidate files in a dedicated `file-loop` worktree, asks the configured reviewer profile to classify the next change, applies only `trivial` edits automatically, records larger follow-up ideas in `loop.md`, and publishes one PR when the session ends.

Operational constraints:

- File-loop work runs only when a repo has no active issue runs.
- Sessions are started and stopped explicitly through CLI, MCP, or the TUI file-loop tab.
- Top-level `fileLoop` values provide defaults; `repos[].fileLoop` merges over them for per-repo overrides.
- Final publish runs `finalizeVerify`; if verification fails, `onFailure` controls whether a draft PR is still opened.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Master gate. `night-orch file-loop start` refuses to start when disabled for the repo. |
| `maxDurationMinutes` | positive int | `480` | Hard wall-clock cap per session unless `start --max-minutes` overrides it. |
| `maxIterations` | positive int | `1000` | Upper bound on file-loop iterations per session. |
| `minIntervalSecondsBetweenFiles` | int >= 0 | `5` | Cooldown before reconsidering the next file. |
| `perIterationTimeoutSeconds` | positive int | `120` | Timeout for each reviewer worker invocation. |
| `maxCostUsd` | non-negative number | `5` | Session cost cap. Hitting it requests finalization. |
| `maxFileLines` | positive int | `1500` | Skip files larger than this line count. |
| `includeGlobs` | string[] | `["**/*.{ts,tsx,js,jsx,py,go,rs,md}"]` | Candidate file allowlist. |
| `excludeGlobs` | string[] | built-in list | Candidate file denylist. Defaults exclude generated artifacts, lockfiles, `.git`, and `loop.md`. |
| `reviewerProfileKey` | string | `claude-cheap` | Worker profile name, or a worker `type`, used for file review iterations. Override this if your config does not define `claude-cheap`. |
| `branchNameTemplate` | string | `orch/file-loop/{repoSlug}/{yyyyMmDd}` | Supports `{repoSlug}` and `{yyyyMmDd}` placeholders. |
| `loopMdPath` | string | `loop.md` | Repo-relative backlog file for deferred refactor notes. |
| `commitPrefix` | string | `[FILE-LOOP]` | Prefix used for per-file and `loop.md` commits. |
| `perEditVerify` | object | object with defaults | Verification run immediately after each trivial edit. |
| `finalizeVerify` | object | object with defaults | Verification run once before PR publication/finalization. |

### `fileLoop.perEditVerify`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | If false, trivial edits are committed without per-file verification. |
| `commands` | string[] | `["pnpm typecheck"]` | Commands run sequentially in the file-loop worktree. |
| `timeoutSeconds` | positive int | `60` | Per-command timeout budget. |

### `fileLoop.finalizeVerify`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | If false, publication does not run final verification. |
| `commands` | string[] | `["pnpm typecheck", "pnpm lint"]` | Commands run sequentially before publication. |
| `timeoutSeconds` | positive int | `300` | Per-command timeout budget. |
| `onFailure` | `draft-pr` \| `no-pr` | `draft-pr` | Whether to still open a draft PR when final verification fails. |

## `security`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxChangedFiles` | positive number | `50` | Diff guard threshold. |
| `maxChangedLines` | positive number | `5000` | Diff guard threshold. |
| `maxDailyCostUsd` | positive number | `50` | Daily budget cap, enforced in `pay-per-use` and optionally in `subscription-metered` (`cost.subscriptionMetered.enforceDailyLimit`). |
| `maxCostPerRunUsd` | positive number | `10` | Per-run budget cap, enforced in `pay-per-use` and optionally in `subscription-metered` (`cost.subscriptionMetered.enforcePerRunLimit`). |

### Unblocking a run hit by a cost cap

These controls are interpreted by `cost.model`:

- `pay-per-use`: always enforced
- `subscription`: never enforced (USD advisory only)
- `subscription-metered`: enforced only when
  `cost.subscriptionMetered.enforcePerRunLimit` and/or
  `cost.subscriptionMetered.enforceDailyLimit` are enabled

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
| `model` | `pay-per-use`, `subscription`, or `subscription-metered` | `pay-per-use` | `pay-per-use` enforces `security.maxDailyCostUsd`/`security.maxCostPerRunUsd`; `subscription` bypasses cost-limit blocking; `subscription-metered` logs advisory warnings and can optionally enforce caps via `cost.subscriptionMetered`. |
| `allowEstimatedDuration` | boolean | `false` | When `false` (default), worker runs that finish without parseable token usage **block the attempt** with `tokenCaptureFailed` instead of silently estimating cost from wall-clock duration. The duration estimate undercounted by 10–100× in production and was the root cause of inaccurate cost reports. Flip to `true` only as a temporary unblocker when a specific worker adapter genuinely cannot report token usage. |
| `subscriptionMetered` | object | `{ advisoryThresholdUsd: null, enforcePerRunLimit: false, enforceDailyLimit: false }` | Controls warning/enforcement behavior for `subscription-metered` mode. Ignored for other models. |
| `pricing` | object | unset | Optional model-aware pricing table. When unset, built-in defaults are used (input `$3/M`, output `$15/M`, cache-read `$0.3/M`, fallback `$0.008/min`) for advisory/estimated USD. |

### `cost.subscriptionMetered`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `advisoryThresholdUsd` | positive number or `null` | `null` | Logs warnings when run/day estimated cost meets or exceeds this threshold. |
| `enforcePerRunLimit` | boolean | `false` | When true, applies `security.maxCostPerRunUsd` as a hard block in `subscription-metered`. |
| `enforceDailyLimit` | boolean | `false` | When true, applies `security.maxDailyCostUsd` as a hard block in `subscription-metered`. |

### Cost accounting layers

Night-orch tracks three distinct numbers so a subscription `$0` real cost never hides real usage:

1. **Tokens** — raw prompt/completion/cache counts. The runaway rail (`loop.maxRunTokens`/`maxIssueTokens`/`maxDailyTokens`) reads these, independent of money.
2. **Theoretical cost** — `tokens × cost.pricing`, computed for every worker call **regardless of billing model**. This is what the work *would* cost on metered pricing; recorded even when the real charge is `$0`. Stored per run, per day, and per ledger entry.
3. **Real cost** — subscription-normalized USD. `$0` inside a subscription quota; `> 0` once metered or overflowed. Drives the USD caps (`security.maxCostPerRunUsd`/`maxDailyCostUsd`).

### `cost.subscriptionQuota`

Optional. Models a subscription's included allowance and what happens once it is exhausted (billing swaps to usage-based). Compares cumulative **theoretical** spend for the period against `includedUsd`. Only applies when `cost.model` is `subscription` or `subscription-metered`.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `includedUsd` | positive number | — (required when set) | Included allowance in theoretical USD for the period. |
| `period` | `day` or `month` | `month` | Window over which theoretical spend is summed. |
| `onExhausted` | `warn` or `enforce` | `warn` | `warn` logs once per period and keeps running; `enforce` treats the overage as metered spend and applies `security.maxDailyCostUsd` against it, so a blown quota can block new work even though the real charge column reads `$0`. |

### `cost.pricing`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `defaultModel` | string | `"default"` | Fallback key when a worker's `pricingModel`/`type` has no direct pricing entry. |
| `models` | record | `{}` | Per-model pricing map keyed by model name. |

### `cost.pricing.models.<model>`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `inputUsdPerMillionTokens` | non-negative number | `3` | Prompt/input token price in USD per 1,000,000 tokens. |
| `outputUsdPerMillionTokens` | non-negative number | `15` | Completion/output token price in USD per 1,000,000 tokens. |
| `cacheReadUsdPerMillionTokens` | non-negative number | `0.3` | Cached-input read token price in USD per 1,000,000 tokens. |
| `minuteUsd` | non-negative number | `0.008` | Time-based fallback price per minute when token counts are unavailable. |

Validation notes:

- `cost.pricing.defaultModel` must reference a key present under `cost.pricing.models` when models are provided.
- `workerProfiles.<name>.pricingModel` must reference a key present under `cost.pricing.models`.

## `ai`

Phase 3: direct-LLM API layer for night-orch's **internal** AI
tasks — triage refinement, PR body summaries, reviewer parse
salvage, and a bounded rebase-conflict resolver. This does NOT
replace the Claude Code / Codex / opencode CLIs used for actual
code-editing (planner, coder, reviewer); those keep running on the
CLI path because they rely on the agentic tool-use loop that the
direct API doesn't have. The conflict resolver is the narrow
exception: it operates on one conflicted file at a time, validates
the returned file, and falls back to the normal human block path on
any failure.

When no `ai.internal.enable.*` flag is set the entire layer is a
no-op and every consumer falls back to its pre-Phase-3 behavior
(rule-based triage, template-only PR body, fail-closed reviewer
parser). The conflict resolver is gated separately by
`autoResolveConflicts.enabled` and
`ai.internal.features.conflictResolver`.

### `ai.internal`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `provider` | `"anthropic"` \| `"openrouter"` \| `"openai"` \| `null` | `null` | Which direct-LLM backend to use. `null` disables the layer. |
| `model` | string \| `null` | `null` | Model id passed to the provider (e.g. `"claude-3-5-sonnet-20241022"` for Anthropic, `"anthropic/claude-3.5-sonnet"` for OpenRouter, `"gpt-4o-mini"` for OpenAI). |
| `apiKeyEnv` | string \| `null` | `null` | Env var name holding the API key. Refuses literal keys in YAML. |
| `timeoutMs` | positive int | `30000` | Per-request timeout. |
| `maxTokens` | positive int | `1024` | Default max tokens per call. Each consumer may override. |
| `features.conflictResolver` | boolean | `true` | Enables the internal-AI conflict resolver feature when `autoResolveConflicts.enabled` is also `true`. If provider/model/API key are missing at runtime, the resolver quietly falls back to the existing human block path and `doctor` reports it as unavailable. |
| `enable.triage` | boolean | `false` | LLM refines rule-based triage classification. |
| `enable.reviewerParseFallback` | boolean | `false` | When the primary reviewer JSON parser fails, ask the LLM to salvage a structured verdict (CHANGES_REQUIRED or BLOCKED only — APPROVED is never inferred from free text). |
| `enable.prBody` | boolean | `false` | Prepends a 2-3 sentence plain-English summary to PR body bodies. The structured template still renders below. |

Validation:

- When any `enable.*` flag is `true`, all three of `provider`,
  `model`, and `apiKeyEnv` must be set. The schema rejects the
  config otherwise at load time.
- `apiKeyEnv` must be an environment variable name, not a
  literal API key — the schema rejects values that look like
  inline secrets (`sk-…`, `claude-…`).

**Security**: AI API keys are added to the worker environment
blacklist, so `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, and any `ANTHROPIC_*` / `OPENAI_*` /
`OPENROUTER_*` env var are blocked from reaching CLI worker
subprocesses. Pino redaction also scrubs `apiKey` and `x-api-key`
fields from every log record.

**Cost tracking**: every AI call records through the same R4 cost
ledger as CLI workers, tagged `tokenSource='measured_api'` and
`workerType='internal-ai'` or `workerType='internal-ai-conflict-resolver'`.
The `/api/cost/health` endpoint surfaces these as distinct funding
sources so operators can see direct-API spend alongside CLI spend.

Example:

```yaml
ai:
  internal:
    provider: anthropic
    model: claude-3-5-sonnet-20241022
    apiKeyEnv: ANTHROPIC_API_KEY
    features:
      conflictResolver: true
    enable:
      triage: true
      reviewerParseFallback: true
      prBody: true
```

## `autoResolveConflicts`

Controls the bounded AI-assisted resolver that runs only after a
queued `rebase` operation hits textual conflicts.

If resolution succeeds, night-orch continues the rebase, force-pushes
the branch, and then follows the existing verify contract:
- verify passes: the run returns to `review_ready`
- verify fails: the coder loop runs as usual

If resolution fails, validation fails, the provider is unavailable,
or the feature is disabled, night-orch aborts the rebase and blocks
the run with the existing `merge_conflict` reason.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch for the automated resolver pass. |
| `maxAttempts` | int 1-5 | `2` | Maximum number of `resolve -> git add -> git rebase --continue` cycles before falling back to the human block path. |
| `maxFiles` | int 1-20 | `5` | Maximum number of conflicted files eligible for one automated attempt. Larger conflict sets skip auto-resolution and block immediately. |

Example:

```yaml
autoResolveConflicts:
  enabled: true
  maxAttempts: 2
  maxFiles: 5
```

## `workerProfiles`

`workerProfiles` is a map of profile name to profile config.

Example:

```yaml
workerProfiles:
  claude-default:
    type: claude
    command: claude
    args: ["-p"]
    sandbox:
      type: host
```

### `workerProfiles.<name>`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `type` | string | yes | none | Adapter type. Built-in: `claude`, `codex`, `acp`. OpenCode uses `acp` with `command: opencode`. |
| `pricingModel` | string | no | none | Optional model key used by `cost.pricing.models` for cost estimation. Falls back to `type` when omitted. |
| `minuteUsd` | non-negative number | no | none | Optional profile-level duration fallback override used when token usage is unavailable. |
| `command` | string | yes | none | Binary to execute. |
| `args` | string[] | no | `[]` | Base CLI args for every task invocation. |
| `workerTimeoutSeconds` | positive number | no | `1800` | Base timeout before triage scaling. |
| `minimalEnv` | boolean | no | `true` | Deprecated/ignored; worker env is always whitelist-based. |
| `runtimeWrapper` | string or `null` | no | `null` | Wrapper command prepended before `command` (for sandbox wrappers, etc.). |
| `env` | record string->string | no | `{}` | Extra env vars for worker process; blacklist still applies. |
| `sandbox` | object | no | `{ type: "host" }` | Worker execution sandbox. Use `host` for current host execution, `docker` or `podman` for container isolation. |
| `allowAgentSessionBypass` | boolean | no | `false` | Allow the web agent-session endpoint to run this profile with unsafe Claude permission modes such as `bypassPermissions` or `acceptEdits`. Keep this `false` unless the profile is intentionally exposed to trusted operators only. |

Worker `PATH` is normalized at runtime: if missing, `~/.local/bin`, `~/.local/share/pnpm`,
`~/.local/share/mise/shims`, `/usr/local/bin`, `/usr/bin`, and `/bin` are appended.

`repos[].agents` references these profile names. Unknown profile references fail config load.

### Worker Execution Context

Worker processes are spawned with their current working directory set to the run's git worktree.
That worktree is a full checkout of the target repository, so repo-local files such as
`.claude/skills/`, `.claude/commands/`, and `.night-orch/prompts/` are visible to the worker.
Custom prompt templates may rely on this: a prompt can invoke repo-scoped skills or commands
that are checked into the repository under `.claude/`.

This does not relax environment isolation. Worker subprocesses still receive only the
whitelist-based environment built by `buildWorkerEnv()`, and forge credentials, API keys,
webhook URLs, and other blacklisted secrets are still stripped even though the worker can see
the worktree files.

### `workerProfiles.<name>.sandbox`

Sandbox settings choose where Sandcastle runs the worker CLI.

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `type` | `host`, `docker`, or `podman` | no | `host` | `host` uses night-orch's strict host sandbox provider. `docker` and `podman` use Sandcastle container providers. |
| `image` | string | no | provider default | Container image name for Docker/Podman. Ignored for `host`. |
| `containerUid` | positive integer | no | provider default | UID of the `agent` user inside the image. Must match the image. |
| `containerGid` | positive integer | no | provider default | GID of the `agent` user inside the image. Must match the image. |
| `mounts` | array | no | `[]` | Additional bind mounts with `hostPath`, `sandboxPath`, and optional `readonly`. Use this for Codex/Claude subscription auth config. |
| `env` | record string->string | no | `{}` | Extra sandbox env. The same secret blacklist used by worker env applies; forge/API tokens are skipped. |
| `network` | string or string[] | no | provider default | Docker/Podman network name(s). |

Example Docker profile:

```yaml
workerProfiles:
  codex-docker:
    type: codex
    command: codex
    args: ["exec", "--json"]
    sandbox:
      type: docker
      image: night-orch-agent:latest
      containerUid: 1000
      containerGid: 1000
      mounts:
        - hostPath: ~/.codex
          sandboxPath: /home/agent/.codex
      env:
        CODEX_HOME: /home/agent/.codex
      network: night-orch-test
```

Do not pass API keys, forge tokens, webhook URLs, or other secret env vars to workers or sandboxes.
The worker env whitelist and sandbox env filter are designed to keep those values out. For
subscription CLI auth, mount the relevant CLI config directory explicitly and keep container `HOME`
and `XDG_*` paths aligned with the image.

### Authentication Considerations

Night-orch invokes the `claude` CLI as a subprocess — it does not handle authentication itself. The installed `claude` binary uses whatever auth is configured on the host (OAuth subscription login or API key).

**For production / high-volume deployments**, configure the `claude` CLI with an **API key** (`ANTHROPIC_API_KEY`) rather than a subscription OAuth login. As of April 2026, Anthropic restricts subscription OAuth to "ordinary, individual usage" of Claude Code and reserves the right to enforce this without notice. API key auth uses metered billing and is unaffected by these restrictions.

**For personal dev-server usage**, subscription OAuth login works fine and is fully supported — night-orch invokes the real `claude` CLI binary, not the API directly.

See [Anthropic's legal and compliance docs](https://code.claude.com/docs/en/legal-and-compliance) for current policy on authentication methods.

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

Notes:

- For the default Docker-based monitoring stack, keep `metrics.host: 0.0.0.0` so Prometheus can scrape the daemon from its container network.
- `metrics.enabled` is runtime-overridable (`night-orch settings set metrics.enabled ...`). `night-orch status` reports when runtime state diverges from YAML.

## `observability`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `agentStreaming` | boolean | `true` | Enable live worker event emission and persistence. |
| `eventRetention` | int (100-10000) | `1000` | In-memory max agent events retained per run. |
| `sessionLogs` | boolean | `true` | Write per-phase JSONL session logs to `storage.logsRoot/<runId>/`. |
| `sessionLogRetention` | positive int | `7` | Retention target in days for session logs (consumed by cleanup policy). |
| `recordPromptCompilations` | boolean | `true` | Self-improvement (item 3): when true, every worker prompt is SHA-hashed and recorded in `prompt_compilations` for retrospective mining by `night-orch retro`. Set false for low-disk environments or to opt out of prompt persistence. The retro meta-agent skips its own writes via `skipPromptLogging` regardless of this flag. See [ADR 0002](adr/0002-self-improvement-retrospective.md). |

## `mcp`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | When true, `run` starts the embedded MCP HTTP server (dual transport — see below). |
| `transport` | `stdio` | `stdio` | Reserved. The standalone `night-orch mcp` command speaks stdio; the HTTP server started by `run`/`web` exposes streamable HTTP and legacy SSE on the same port regardless of this value. |
| `authTokenEnv` | string or `null` | `null` | Name of an environment variable holding a bearer token. When set and the env var is non-empty, every MCP request must present a matching `Authorization: Bearer …` header. **Required** when `httpHost` is non-loopback. |
| `httpPort` | positive int | `3100` | Port the embedded MCP server listens on. |
| `httpHost` | string | `127.0.0.1` | Host to bind. Loopback (`127.0.0.1`, `::1`, `localhost`) is always allowed; any other host requires `authTokenEnv` to be set. |

### Transports

The embedded MCP server exposes **both** transports on the same port so old and new clients can coexist:

- **Streamable HTTP** (modern) — `POST /mcp`, with `Mcp-Session-Id` response/request header for session routing. Also `GET /mcp` (server-initiated SSE stream) and `DELETE /mcp` (client-initiated session teardown). This is the transport Claude Code's `type: "http"` client speaks.
- **Legacy SSE** — `GET /sse` for the session handshake followed by `POST /mcp?sessionId=…` for follow-up JSON-RPC messages. Kept for backwards compatibility with existing proxies and older MCP clients.

A liveness probe is available at `GET /health` and does not require auth.

### Exposing MCP over a private network

To let a remote Claude Code instance connect directly (e.g. over Tailscale), bind to a non-loopback address and configure a strong bearer token:

```yaml
mcp:
  enabled: true
  httpHost: 100.94.242.23    # e.g. Tailscale IP
  httpPort: 8808
  authTokenEnv: NIGHT_ORCH_MCP_TOKEN
```

```bash
export NIGHT_ORCH_MCP_TOKEN=$(openssl rand -hex 32)
```

Client-side `.mcp.json`:

```json
{
  "mcpServers": {
    "night-orch": {
      "type": "http",
      "url": "http://100.94.242.23:8808/mcp",
      "headers": { "Authorization": "Bearer ${NIGHT_ORCH_MCP_TOKEN}" }
    }
  }
}
```

Non-loopback binding **without** `authTokenEnv` is rejected at startup — exposing mutation tools to an unauthenticated listener is never a supported configuration.

## `web`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `trustedProxy` | boolean | `false` | When `true`, the web auth routes trust `X-Forwarded-Proto: https` from your reverse proxy and emit `Secure` `__Host-` cookies. Enable only when night-orch is reachable only through a proxy you control. |

### Web Auth Notes

Loopback web auth writes the generated mutation token to `$XDG_RUNTIME_DIR/night-orch-web.token` with mode `0600` and also prints it once at startup. `/api/session` returns only a hint to that sidecar path; it does not return the token in the response body. Paste that token into the browser login dialog, or set `NIGHT_ORCH_WEB_AUTH_TOKEN` and bind with operator auth for remote access.

Operator auth sessions use an `HttpOnly` `SameSite=Strict` session cookie with an 8-hour max age. Cookie-authenticated mutation requests must include a matching double-submit CSRF header (`x-csrf-token`) copied from the readable `norch_csrf` cookie, or `__Host-night-orch-csrf` when secure proxy cookies are enabled. Browser clients do this automatically; scripts can avoid cookie+CSRF handling by sending the configured bearer token with `x-night-orch-web-token`.

## `commentCommands`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable processing of `/orch` commands in issue comments. |
| `requireCollaborator` | boolean | `true` | Only repo collaborators can use comment commands. When `commentCommands` is omitted, the runtime still treats this as `true`. Set to `false` only for private repos where all commenters are trusted; explicit opt-out logs a warning each cycle. |
| `acceptMentions` | boolean | `true` | Treat free-form mentions such as `@night-orch please rework error handling` as continue feedback while the PR is `review_ready`. |
| `mentionAliases` | string[] | `[]` | Additional aliases that trigger mention feedback, for example `["@night-orch", "@orch"]`. The configured bot username is also accepted as an alias. |
| `reviewBotAllowlist` | string[] | `[]` | Exact `[bot]` logins whose review comments should be accepted as review feedback, for example `["coderabbitai[bot]", "copilot[bot]"]`. Non-allowlisted bot review comments are ignored. |

Supported commands (posted as issue comments):
- `/orch retry` — start a fresh retry from the latest base branch
- `/orch rebase` — queue an explicit rebase of the work branch onto the latest base
- `/orch cancel` — cancel an active run
- `/orch continue` — resume the existing branch with fresh context for blocked/review-ready/errored runs

When a PR becomes non-mergeable while it is in `review_ready`, night-orch does not treat that as a generic continue. It queues a dedicated branch refresh attempt that uses the repo's `updateStrategy`, and if that refresh conflicts the blocked run stores a durable conflict snapshot for the next `/orch continue` pass.

Free-form mentions use the same collaborator gate as `/orch` commands for human authors when `requireCollaborator` is true. Allowlisted review bots are checked before that gate because forge collaborator APIs usually do not treat app bots as ordinary collaborators. Mentions inside fenced or indented code blocks are ignored, and acknowledgement comments use per-comment markers so retries do not post duplicate replies.

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
      - { type: worker, id: cr, role: reviewer, prompt: code-review.md, reviewerKey: code-review }
      - { type: worker, id: review, role: reviewer }
      - { type: decide, id: decide, onIterate: code }

  with-external-review:
    steps:
      - { type: worker, id: plan, role: planner, skipWhen: trivial }
      - { type: worker, id: code, role: coder, continueFrom: plan }
      - { type: verify, id: verify }
      - { type: worker, id: review, role: reviewer }
      - { type: decide, id: decide, onIterate: code }
      - type: worker
        id: cr
        role: reviewer
        runWhen: post-publish
        prompt: .night-orch/prompts/cr-skill.md
        commentPrefix: "[night-orch][cr]"
```

When a workflow has multiple reviewer steps, Night-Orch stores each reviewer result by step id and merges the findings before the next coder iteration. `decide` uses a worst-of verdict: any `BLOCKED` blocks, otherwise any `CHANGES_REQUIRED` iterates, otherwise all-approved publishes when verification passes.

Post-publish reviewer steps run only after the branch has been pushed and a PR exists. They are intended for external review tools such as CodeRabbit or Snyk invoked from a reviewer prompt. A non-approved result is stored as an `external-review-findings` handoff, posted to the issue when enabled, and by default queues a continue pass with the findings as `external_review` feedback.

In `steps` workflows, declare post-publish workers after the `decide` step. They are owned by PR finalization, so `decide.onIterate` must target a pre-decision step such as `code`, never a `runWhen: post-publish` step.

### Step Types

| Type | Fields | Description |
| --- | --- | --- |
| `worker` | `id`, `role`, `skipWhen?`, `continueFrom?`, `prompt?`, `reviewerKey?`, `runWhen?`, `onChangesRequired?`, `commentOnIssue?`, `commentPrefix?` | Invoke a worker adapter. Built-in roles: `planner`, `coder`, `reviewer`. |
| `verify` | `id`, `skipWhen?`, `profile?`, `stage?` | Run verify commands from `repos[].verify` or a named verification profile/stage. |
| `decide` | `id`, `onIterate`, `requireReview?` | Evaluate review/verify results and route to publish, iterate (jump to `onIterate` step), or block. |

- `skipWhen` — skip the step when the triage level matches (e.g., `trivial`)
- `continueFrom` — continue the AI session from a prior step (e.g., coder continues planner's session). Session reuse is agent-specific; cross-agent handoffs (for example `planner=claude`, `coder=codex`) start a fresh session.
- `prompt` — path to a custom system prompt template (overrides the default). Worker CWD is the worktree, so repo-local prompt files can invoke repo-local `.claude/skills/` and `.claude/commands/`.
- `reviewerKey` — reviewer result slot for `role: reviewer`; defaults to the step `id`. Set this when two reviewer steps should intentionally write the same slot.
- `runWhen` — `pre-decide` by default. Set reviewer steps to `post-publish` to run after PR creation.
- `onChangesRequired` — for post-publish reviewer steps, `continue` by default; set `comment-only` to post findings without queuing another pass.
- `commentOnIssue` — for post-publish reviewer steps, default `true`; when enabled, upserts a per-attempt issue comment with the external findings.
- `commentPrefix` — optional prefix for the post-publish issue comment, for example `[night-orch][cr]`.
- `requireReview` — default `true`; set to `false` for no-review workflows (for example lightweight triage paths)
- `profile` / `stage` on verify steps — override repo-level verification profile selection for this step

### Workflow-Level Overrides

- `roles` — optional role defaults (`planner`/`coder`/`reviewer`) for runs using this workflow
- `agents` — optional per-agent worker profile overrides (same shape as `repos[].agents`)

Reference a workflow in `repos[].workflow` by name.

### DAG Workflows

Instead of `steps`, a workflow can define `dag` with explicit stage links:

```yaml
workflows:
  dag-minimal:
    dag:
      entry: code
      stages:
        code:
          type: worker
          role: coder
          next: verify
        verify:
          type: verify
          profile: strict
          stage: smoke
          next: decide
        decide:
          type: decide
          onIterate: code
```

Rules:
- Define **either** `steps` or `dag` (not both).
- `dag.entry` must exist in `dag.stages`.
- `worker` and `verify` stages are non-terminal and must set `next`.
- DAG workflows must terminate at a `decide` stage.

## `verificationProfiles`

Named staged verification command sets. Reusable from `repos[].verificationProfile` and workflow verify steps (`profile`/`stage`).

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
```

Stage keys:
- `id` — stage name referenced by workflow verify step `stage`.
- `commands` — `CommandSpec[]` (`string`, `string[]`, or `{ command, timeoutSeconds }`).
- `timeoutSeconds` — stage-level default timeout for commands without explicit timeout.
- `required` — default `true`; when `false`, failures do not fail verification gating.
- `onFailure` — `block` (default), `iterate`, or `warn` (reserved for policy routing/observability).

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
| `updateStrategy` | `merge` \| `rebase` | no | `merge` | How normal queued work incorporates upstream base branch changes by default. `merge` creates merge commits (reliable for automated systems). `rebase` replays commits for linear history (use only if your repo requires linear history). This setting is used by automatic branch refreshes, merge-conflict follow-up attempts, and publish-time branch reconciliation. Manual `retry`, `continue`, and `rebase` actions can override it per action from the CLI, TUI, MCP, or web UI; explicit `rebase` still defaults to `rebase` unless overridden. |
| `labels` | object | no | object with defaults | Orchestration label names. |
| `kanban` | object | no | none | Optional alternate state-label flow activated by a trigger label. |
| `labelConfig` | record | no | `{}` | Label metadata overrides for `labels-init`. |
| `defaults` | object | no | object with defaults | Default roles + mention settings. |
| `planning` | object | no | object with defaults | Planning-only mode settings (PRD path). |
| `fileLoop` | object | no | `{}` | Per-repo overrides merged onto top-level `fileLoop`. |
| `environment` | object | no | none | Shared/dedicated env setup. |
| `verify` | `CommandSpec[]` | no | `[]` | Verify commands run in worktree. |
| `verificationProfile` | string | no | none | Default named verification profile for verify steps in this repo. |
| `preflight` | object | no | `{ enabled: false }` | Preflight drift gate — verify the base branch is green before dispatching fresh work. See below. |
| `prompts` | object | no | none | Optional custom system prompt template paths. |
| `selectors` | object | no | object with defaults | Issue label inclusion/exclusion filters. |
| `agents` | record | no | `{}` | Maps agent names to worker profile names. |
| `workflow` | string | no | none | Name of a workflow from `workflows` section. Uses default pipeline if omitted. |
| `workflowByTriage` | object | no | none | Per-triage workflow selection (`trivial`/`standard`). |
| `mergeQueue` | object | no | object with defaults | Merge queue configuration. |
| `autoRebaseOnMerge` | object | no | `{ enabled: false, maxFanout: 10, strategy: 'rebase' }` | Automatic rebase fan-out after a tracked PR merges. |

Poll execution model:
- Repos are polled in parallel.
- Each repo runs up to `maxConcurrentRuns` issues at once (default `1`).

### `repos[].preflight`

Before dispatching fresh work in a poll cycle, optionally run a fast check against the repo's **base branch HEAD**. If the base is already red (drift not caused by any queued issue), the whole batch is skipped for that cycle — preventing every issue from failing in series and injecting unrelated stale-base reverts into diffs. Runs in a dedicated, hard-reset base worktree; never touches in-flight issue branches. Skipped for targeted (`/orch run <issue>`) runs.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Turn the gate on for this repo. |
| `stage` | string | none | Stage id within the repo's `verificationProfile` to run as the gate. |
| `commands` | `CommandSpec[]` | none | Explicit commands; overrides `stage`/`verify` resolution. |

Command resolution cascade: `commands` → the named `stage` of the repo's `verificationProfile` → the repo's `verify[]`. Only `block`/`iterate` (non-`warn`) required stage commands gate the batch.

```yaml
repos:
  - repo: org/app
    verify: [pnpm typecheck, pnpm test]
    preflight:
      enabled: true
      commands: [pnpm typecheck]   # cheap smoke check against base HEAD
```

### Project-local repo overrides

You can move repo-specific settings into a file inside the repository checkout:

```yaml
# <repo>/.night-orch.yml
workflow: project-fast
verificationProfile: strict
defaults:
  coder: codex
environment:
  bootstrap:
    - command: pnpm install
      when: always

workflows:
  project-fast:
    steps:
      - { type: worker, id: code, role: coder }
      - { type: verify, id: smoke, stage: smoke }
      - { type: decide, id: decide, onIterate: code }

verificationProfiles:
  strict:
    stages:
      - id: smoke
        commands: [pnpm typecheck]
```

This file is merged with the matching `repos[]` entry from central config.

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
| `ready` | string or string[] | `['no:ready']` | Normalized to array. |
| `running` | string | `no:running` |  |
| `blocked` | string or string[] | `no:blocked` | Normalized to array. |
| `needsHuman` | string | `no:needs-human` |  |
| `reviewReady` | string | `no:review-ready` |  |
| `error` | string | `no:error` |  |
| `retry` | string | `no:retry` |  |
| `planning` | string | `no:planning` | When present on an issue, night-orch switches to planning-only mode and publishes only a PRD markdown file. |
| `mergeQueued` | string | `no:merge-queued` | Set when PR enters the merge queue. |
| `merging` | string | `no:merging` | Set while staging branch CI is running. |
| `mergeFailed` | string | `no:merge-failed` | Set when the merge queue identifies this PR as the culprit. |
| `rebasing` | string | unset | Optional distinct label used while a queued or running attempt has `operationIntent: rebase`; falls back to `running` when unset. |

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
        rebasing: kanban:rebasing
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
| `planner` | `claude`, `codex`, or `opencode` | `claude` | Default planner role assignment. |
| `coder` | `claude`, `codex`, or `opencode` | `codex` | Default coder role assignment. |
| `reviewer` | `claude`, `codex`, or `opencode` | `codex` | Default reviewer role assignment. |
| `doneMode` | `pr-ready` or `manual-only` | `pr-ready` | Reserved for workflow policy; currently not consumed in runtime logic. |
| `notifyPriority` | `normal` or `high` | `normal` | Reserved for notification priority; currently not consumed in notifier routing. |
| `prMentions` | string[] | `[]` | Mention aliases posted on PRs by default. |

Role labels can override these defaults per issue:

- `plan:claude` / `plan:codex` / `plan:opencode`
- `code:claude` / `code:codex` / `code:opencode`
- `review:claude` / `review:codex` / `review:opencode`

Planning-only mode label:

- `no:planning` (or whatever `repos[].labels.planning` is set to)

When this label is present, night-orch uses a planning-only workflow and must produce a PR containing exactly one PRD markdown file.

### `repos[].planning`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `prdDirectory` | string | `docs/prd` | Repository-relative directory where planning-mode PRD files are created. |

### `repos[].fileLoop`

Repo-level file-loop overrides merge onto the top-level `fileLoop` block for that repo only.

Example:

```yaml
fileLoop:
  enabled: false
  reviewerProfileKey: claude-default

repos:
  - repo: myorg/myrepo
    fileLoop:
      enabled: true
      maxDurationMinutes: 180
      reviewerProfileKey: codex-default
      includeGlobs:
        - "src/**/*.{ts,tsx}"
      excludeGlobs:
        - "src/generated/**"
```

Repo overrides support the same keys as top-level `fileLoop`, but every field is optional. Nested `perEditVerify` and `finalizeVerify` objects merge field-by-field rather than replacing the entire object.

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
| `failureHints` | object[] | no | `[]` | Optional pattern-based hints appended to bootstrap error output. |

##### `failureHints[]`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `contains` | string | yes | none | Substring to match against command output. |
| `message` | string | yes | none | Hint text shown when the pattern matches. |
| `output` | `combined` \| `stdout` \| `stderr` | no | `combined` | Which output stream(s) to inspect. |

### `repos[].verify`

Array of commands executed sequentially in worktree. Failures are collected per command; verification result is evaluated after all commands run.

### `repos[].prompts`

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `plannerSystem` | string path | no | If file exists, used instead of default planner system prompt. |
| `coderSystem` | string path | no | If file exists, used instead of default coder system prompt. |
| `reviewerSystem` | string path | no | If file exists, used instead of default reviewer system prompt. |

If a configured template file is missing, a warning is logged and built-in defaults are used.
Prompt templates execute inside the worktree. A template stored at `.night-orch/prompts/coder-system.md`
can refer to repo-local `.claude/skills/` or `.claude/commands/`, and the worker CLI resolves them
from the checked-out repository for that run.

### `repos[].selectors`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `includeLabelsAny` | string[] | `['no:ready']` | Issue must include at least one (empty list means include all). |
| `excludeLabelsAny` | string[] | `['no:blocked', 'no:error', 'no:needs-human']` | Issue is skipped if any label matches. |

### `repos[].agents`

Map of agent name to worker profile name.

Typical shape:

```yaml
agents:
  claude: claude-default
  codex: codex-default
  opencode: opencode-qwen
```

Resolution behavior:

1. If mapping exists and profile exists, that profile is used.
2. Otherwise, night-orch falls back to first profile whose `type` matches the role agent (`claude`/`codex`/`opencode`).
3. If no matching profile exists, the run fails.

OpenCode runs through the `acp` adapter with `command: opencode`. The target repo must have an `opencode.json` defining available models and provider config. To select different models per role, use `OPENCODE_CONFIG_CONTENT` in the worker profile's `env` to override the default model:

```yaml
workerProfiles:
  opencode-qwen:
    type: acp
    command: opencode
    env:
      OPENCODE_CONFIG_CONTENT: '{"model":"openrouter/qwen/qwen3-coder"}'
  opencode-kimi:
    type: acp
    command: opencode
    env:
      OPENCODE_CONFIG_CONTENT: '{"model":"openrouter/moonshotai/kimi-k2.5"}'
```

OpenCode reads API credentials from its own auth store (`~/.local/share/opencode/auth.json`, configured via `opencode /connect`). Since `HOME` is on the worker env whitelist, no additional env changes are needed.

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

Labels used: `no:merge-queued`, `no:merging`, `no:merge-failed`.

### `repos[].autoRebaseOnMerge`

When enabled, a merged tracked PR queues rebase attempts for open tracked sibling PRs in the same repo and base branch. Detection runs during the existing sync poll cycle and merge-queue finalization path; it does not require webhooks.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Turn fan-out rebasing on for this repo. |
| `maxFanout` | int 1-50 | `10` | Maximum sibling PRs queued from one merged source PR. |
| `strategy` | `rebase` \| `merge` | `rebase` | How sibling worktrees pick up the merged base. Forwarded to the queued rebase attempt's `updateStrategy`. |
| `maxChainLength` | int >= 1 | `loop.maxAttemptChainLength * 2` | Optional cap for fan-out rebase attempt chains. Exhausted chains are skipped with a PR comment. |

Fan-out is idempotent per `(repo, source PR)` through the `rebase_fanouts` table. Each sibling outcome is recorded separately, and the source marker is written even when some siblings fail to queue so partial failures do not replay the entire fan-out. Retention pruning removes old fan-out markers with the normal archive cutoff.

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
