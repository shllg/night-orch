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
6. `~/.config/night-orch/config.yaml`
7. `~/.config/night-orch/config.yml`

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

## Top-Level Schema

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `version` | `1` | yes | none | Schema version. |
| `github` | object | yes | none | Global forge/auth settings. |
| `storage` | object | no | object with defaults | DB/worktree/log paths. |
| `notifications` | object | no | object with defaults | Channel/event notification config. |
| `loop` | object | no | object with defaults | Loop decision limits and behavior. |
| `security` | object | no | object with defaults | Diff/cost safety limits. |
| `workerProfiles` | record | no | `{}` | Named CLI profiles for agents. |
| `metrics` | object | no | object with defaults | Prometheus exporter config. |
| `mcp` | object | no | object with defaults | MCP server config for run/mcp commands. |
| `repos` | array | yes | none | At least one repo is required. |

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

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `dbPath` | string path | no | `~/.config/night-orch/state.db` |
| `worktreeRoot` | string path | no | `~/code/.night-orch/worktrees` |
| `logsRoot` | string path | no | `~/code/.night-orch/logs` |

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

Note: loop limits are later triage-adjusted per issue (trivial/standard/architectural), so these are base values.

## `security`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxChangedFiles` | positive number | `50` | Diff guard threshold. |
| `maxChangedLines` | positive number | `5000` | Diff guard threshold. |
| `maxDailyCostUsd` | positive number | `50` | Daily budget cap used by decision logic. |
| `maxCostPerRunUsd` | positive number | `10` | Per-run budget cap used by decision logic. |

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
| `type` | `claude` or `codex` | yes | none | Adapter selection. |
| `command` | string | yes | none | Binary to execute. |
| `args` | string[] | no | `[]` | Base CLI args for every task invocation. |
| `workerTimeoutSeconds` | positive number | no | `1800` | Base timeout before triage scaling. |
| `minimalEnv` | boolean | no | `true` | Deprecated/ignored; worker env is always whitelist-based. |
| `runtimeWrapper` | string or `null` | no | `null` | Wrapper command prepended before `command` (for sandbox wrappers, etc.). |
| `env` | record string->string | no | `{}` | Extra env vars for worker process; blacklist still applies. |

`repos[].agents` references these profile names. Unknown profile references fail config load.

## `metrics`

| Key | Type | Default |
| --- | --- | --- |
| `enabled` | boolean | `true` |
| `port` | positive int | `9090` |
| `host` | string | `127.0.0.1` |

## `mcp`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | When true, `run` starts embedded HTTP/SSE MCP server. |
| `transport` | `stdio` | `stdio` | Current schema only allows `stdio`. |
| `authTokenEnv` | string or `null` | `null` | If set, mutating MCP tools require matching `authToken` argument. |
| `httpPort` | positive int | `3100` | Host/port used by embedded HTTP/SSE server started by `run`. |
| `httpHost` | string | `127.0.0.1` | Host bind for embedded HTTP/SSE server. |

## `repos[]`

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `repo` | `owner/name` string | yes | none | Repository slug. |
| `forge` | `github` or `forgejo` | no | `github` | Forge implementation selector. |
| `apiBaseUrl` | URL string | no | none | Required for `forgejo`; optional override for `github`. |
| `tokenEnv` | string | no | none | Token env override per repo. |
| `localPath` | string path | yes | none | Local repo checkout path. |
| `baseBranch` | string | no | `main` | PR target branch. |
| `branchPrefix` | string | no | `orch` | Work branch prefix. |
| `labels` | object | no | object with defaults | Orchestration label names. |
| `labelConfig` | record | no | `{}` | Label metadata overrides for `labels-init`. |
| `defaults` | object | no | object with defaults | Default roles + mention settings. |
| `environment` | object | no | none | Shared/dedicated env setup. |
| `verify` | `CommandSpec[]` | no | `[]` | Verify commands run in worktree. |
| `prompts` | object | no | none | Optional custom system prompt template paths. |
| `planning` | object | no | object with defaults | Planning-only mode label and PRD output location. |
| `selectors` | object | no | object with defaults | Issue label inclusion/exclusion filters. |
| `agents` | record | no | `{}` | Maps agent names to worker profile names. |

### `repos[].labels`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `ready` | string or string[] | `['orch:ready']` | Normalized to array. |
| `running` | string | `orch:running` |  |
| `blocked` | string or string[] | `['orch:blocked', 'orch:needs-human']` | Normalized to array. |
| `reviewReady` | string | `orch:review-ready` |  |
| `error` | string | `orch:error` |  |
| `retry` | string | `orch:retry` |  |

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
| `planningSystem` | string path | no | If file exists, used instead of default planning-mode coder prompt. |
| `reviewerSystem` | string path | no | If file exists, used instead of default reviewer system prompt. |

If a configured template file is missing, a warning is logged and built-in defaults are used.

### `repos[].planning`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `label` | string | `orch:planning` | If this label is present on an issue, night-orch runs in planning-only mode. |
| `outputDir` | string | `docs/prd` | Planning mode requires exactly one changed markdown file under this directory. |

Planning mode behavior:

- Runs planner + coder steps only.
- Skips verify/review iteration.
- Blocks publication unless exactly one `*.md` file changed under `outputDir`.
- Intended output is a PRD markdown file (no code changes).

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
