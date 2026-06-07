# Environment Lifecycle Hooks

## Goal

Replace the shared/dedicated environment-mode split with a single isolation model: a per-run worktree plus explicit lifecycle hooks. Each verify command can declare `before`, `after`, and `env`; the whole run can declare `beforeRun` and `afterRun`. Teardown (`after`, `afterRun`) is guaranteed via `finally` — it runs on success, block, error, or thrown exception. This lets stateful integration steps (e.g. `rails test`) bring services up only for their own window and always tear them down, and gives the verifier a sanctioned channel for the env it needs (the original blocking bug).

## Background — why

Run `run-3qn-n7k0KnJD` (issue `shllg/dailywerk#341`) produced correct, reviewer-approved code but was **blocked** because `bundle exec rails test` could not connect to Postgres: `PG::ConnectionBad: password authentication failed for user "app_user"`.

Root cause: in shared mode `setupEnvironment` returns `envOverrides: {}` (`src/environment/manager.ts`), and the verifier env is whitelist-only (`buildVerifierEnv`, `src/workers/env.ts`) with the blacklist pattern `/(?:^|_)PASSWORD(?:$|_)/i` stripping every DB credential var (`TEST_DATABASE_PASSWORD`, `DB_PASSWORD`, `DB_APP_PASSWORD`). The worktree has no `.env` (gitignored; `.env` copy is dedicated-mode only). Rails fell back to a literal default password that did not match the docker-compose `app_user` password → auth failure → `testsPassing:false` → reviewer BLOCKED.

Shared mode is structurally wrong for stateful verification under concurrency: one shared DB, no env channel, no teardown, schema/state bleed between concurrent runs. Rather than patch shared mode, this spec removes it in favor of per-run isolation + lifecycle hooks.

A second, independent defect is bundled: blocked-status comments render as one unreadable paragraph because `formatStatusComment` joins fields with single `\n` (GitHub collapses single newlines).

## Operator Model

A repo declares verification as an ordered list of commands. Each command optionally wraps itself in service lifecycle:

- Cheap, stateless commands (typecheck, lint, frontend unit tests) run with no services.
- A stateful command declares `before` (start services), `env` (creds for the command), and `after` (stop services). `after` always runs.
- The whole issue run can declare `beforeRun` / `afterRun` for run-wide setup/teardown.

There is exactly one isolation model: per-run worktree + hooks. No `shared`/`dedicated` mode selection, no `env:shared`/`env:dedicated` labels.

## Core Behavior

### Run lifecycle
1. Create per-run worktree and branch (unchanged).
2. Allocate per-run isolation tokens once: `{issue}`, `{port}` (unique host port via existing port-allocation logic), `{project}` (compose project name).
3. Run `environment.beforeRun[]` with the run's env (inherited automatically — see Env Resolution).
4. Execute loop phases (plan → code → verify → …).
5. Run `environment.afterRun[]` in an **outer `finally`** wrapping the entire run — fires on success, block, error, or exception. Same inherited run env as `beforeRun`.

### Per-command verify lifecycle
For each verify command, in order:
1. Run `before[]` with the command's resolved `env`.
2. Run `command` **only if `before` succeeded**, with the same resolved `env`.
3. Run `after[]` in a `finally` — **always**, even if `before` or `command` threw or the run is blocking. If `before` started, `after` cleans up the partial state.

Command pass/fail feeds the existing `onFailure` (`warn`/`block`) and `required` chain logic unchanged. Each command's `after` runs regardless of chain decisions.

### Ordering of teardown
On run end, each executed command's `after` has already run (per-command `finally`); `afterRun` runs last in the outer `finally`.

### Failure isolation in teardown
Errors thrown inside `after`/`afterRun` are logged at `warn` and swallowed — they never mask the original run outcome.

## Concurrency

`maxConcurrentRuns > 1` requires per-run isolation so concurrent runs do not share or destroy each other's services. Tokens substituted into every `before`/`after`/`env` string:

- `{issue}` — issue number
- `{port}` — uniquely allocated host port (reuse existing allocator)
- `{project}` — compose project name, e.g. `dailywerk-{issue}`

Example: run A → project `dailywerk-341`, port 5452; run B → project `dailywerk-342`, port 5460. No collision; run A's `after: down -v` cannot affect run B. Within a single run, sequential commands reuse the same token values.

## Config Surface

```yaml
environment:
  ports: { min: 5400, max: 5499 }   # optional; pool for {port} allocation
  beforeRun: [ <command>, ... ]     # optional; whole-issue setup
  afterRun:  [ <command>, ... ]     # optional; whole-issue teardown — always runs (attempt-all)

verify:
  - command: [pnpm, -C, frontend, test]      # no services
  - command: [bundle, exec, rails, test]
    env:
      RAILS_ENV: test
      DATABASE_URL: "postgres://app_user:app_pw@localhost:{port}/dailywerk_test_{run}"
    before:
      - [docker, compose, -p, "{project}", up, -d, --wait]
      - [bundle, exec, rails, db:prepare]
    after:
      - [docker, compose, -p, "{project}", down, -v]   # attempt-all, finally
```

### Schema changes
- The verify command schema becomes an object form gaining: `before: Command[]` (default `[]`), `after: Command[]` (default `[]`), `env: Record<string,string>` (default `{}`). The existing bare-string / bare-array / `{command,timeoutSeconds}` forms remain valid. The **same** `VerifyCommandSchema` is reused by both `verify[]` (legacy list) and `verificationProfiles.stages[].commands[]`, so hooks work in both with one change.
- `required` / `onFailure` stay **stage-level** (they are not, and do not become, per-command fields). Legacy `verify[]` commands keep their resolved defaults (`required: true`, `onFailure: block`). The earlier draft example showing per-command `required`/`onFailure` was wrong.
- **Add** `environment.beforeRun` / `environment.afterRun` (replacing `environment.bootstrap` / `environment.cleanup`) and `environment.ports: { min, max }` (the port-range source that previously lived in `dedicated.env.overrides` `{auto:min-max}` markers; default range applies when omitted).
- **Remove** `environment.defaultMode`, `environment.shared` (`SharedEnvSchema`), `environment.dedicated` (`DedicatedEnvSchema`), the `when:` field on bootstrap commands, and `resolveEnvironmentMode` label handling (`env:shared` / `env:dedicated`).
- `env` accepts string literals only. `envPassthrough: [VAR_NAME]` (forward named host vars) is explicitly **deferred** (YAGNI).

### Token substitution
A single substitution helper expands `{issue}`, `{run}`, `{port}`, `{project}` in every `before`/`after`/`env` value (consolidating today's `substituteIssue` / `substituteCommandToken`).
- `{issue}` — issue number.
- `{run}` — short run id (the per-run unique discriminator; use this in DB names so concurrent runs of the same issue don't collide).
- `{port}` — host port allocated from `environment.ports`.
- `{project}` — compose project name. Default `{repoSlug}-{issue}-{run}` (sanitized repo slug + issue + short run id). Docker project names are **host-global**, so issue-only names collide across repos and with stale prior runs — the slug+run discriminator prevents that.

## Env Resolution & Security

- **Run-level hooks (`beforeRun`/`afterRun`) automatically inherit the run's env** — the same resolved env the run itself operates under (`buildBootstrapEnv`, which already whitelists `DOCKER_*` / `COMPOSE_*`). No per-hook env declaration; they get exactly what the run gets.
- **Command-unit env (shared by `before`, command, `after`):** a whitelist base **plus** the explicit `env{}`. The base must include `DOCKER_*` / `COMPOSE_*` so the `docker compose` hooks reach the configured engine — i.e. the command unit uses the **bootstrap-class whitelist** (superset of the verifier whitelist), not the bare verifier whitelist. before/command/after all get the identical resolved env.
- The command's `env{}` is layered on top via a **dedicated, verifier-only parameter** (e.g. `buildVerifierEnv(safeOverrides, explicitEnv)`), **not** via `deps.envOverrides` — `envOverrides` also feeds `buildWorkerEnv` and must stay blacklist-filtered. Only the explicit per-command `env{}` keys bypass the blacklist.
- **`extendEnv: false`** must be set on the verify `execa` call (`src/loop/verifier.ts`) — it is currently missing, so the verify subprocess inherits the full daemon `process.env` (latent secret leak). `fileloop/verify.ts` already does this; bring the main verifier to parity as part of this work.
- **Security rationale, documented in config docs:** verify/hook commands run inside the AI-coder-authored worktree; a planted `Rakefile`/`Makefile`/npm `postinstall` runs with the command's env. Operator-declared `env{}` values therefore reach attacker-class code, so they must be local/non-secret (a local docker DB URL/password is fine). Genuine host secrets must not be placed here; that need is served later by `envPassthrough`.
- The blacklist still applies to everything **inherited** (`process.env`, worker profile env, runtime/setup overrides); only the explicitly-declared per-command `env{}` keys are exempt.
- pino redaction unchanged.

## Execution & Teardown Semantics

- **Per-command runner (`runVerifyCommands`, `src/loop/verifier.ts`):** for each command, run `before[]` → command → `after[]`. `after[]` runs in a `finally` and uses **attempt-all** semantics — every entry runs even if an earlier one fails; failures are logged `warn`, never thrown. (Do **not** reuse `runBootstrapCommands`, which fail-fasts on first non-zero.) `before[]` keeps fail-fast (a failed setup means the command is recorded as failed and skipped, but its `after[]` still runs to clean partial state).
- **Run-level (`beforeRun`/`afterRun`):** `setupEnvironment` must allocate tokens and mark the env as "assigned" (so the caller's `finally` reaches teardown) **before** running `beforeRun`; if `beforeRun` throws, `afterRun` still runs. `afterRun` uses the same attempt-all semantics. The dispatcher `finally` (`attempt-dispatcher.ts`) already swallows teardown errors and still releases the lease — keep that invariant.
- **Other verify call sites:** `src/loop/preflight.ts` and `src/ops/rebase-and-check.ts` also run verify commands. They go through the same hook-aware `runVerifyCommands`; commands without hooks are unaffected (empty `before`/`after`, no `env`). Token substitution in those paths uses whatever run tokens are available, or none for preflight (base-branch gate has no run context) — preflight commands therefore must not rely on `{port}`/`{project}`.

## Comment Formatting Fix (bundled)

- `formatStatusComment` (`src/forge/status-comment.ts`): separate fields with blank lines (`\n\n`) so GitHub renders them as distinct lines instead of one collapsed paragraph.
- On the blocked path, render review `findings[]` as a markdown bullet list (parity with `formatBlockComment`) instead of a single run-on `blockReason` string.

## Migration

- `config.yaml`: rewrite `shllg/dailywerk` to the hook model (per-command `before`/`after`/`env` for `rails test`; `db:prepare` moved into the command's `before`; drop `environment.defaultMode/shared/dedicated`). `shllg/night-orch` verify is service-free — only the `bootstrap`→`beforeRun` / `cleanup`→`afterRun` rename applies.
- `examples/config.example.yaml`: update to the new schema.
- Removing the mode keys is a breaking config change; document in `docs/CONFIGURATION.md`. Acceptable — the tool and its configs are operator-owned.

## Crash Safety (follow-up, not core)

In-process `finally` covers error/block/exception. A hard process kill (SIGKILL) cannot run `finally`, leaving orphaned compose stacks. `ops/cleanup.ts` should be extended to reap orphaned per-run compose projects (match by `{project}` prefix) alongside stale worktrees. Tracked as follow-up, not required for this spec's acceptance.

## Acceptance Criteria

1. A verify command with `before`/`after`/`env` runs: `before` (with `env`) → `command` (with `env`) → `after`, with `after` in a `finally`.
2. `after` runs when `before` fails, when `command` fails, and when the run blocks.
3. `afterRun` runs on success, block, error, and thrown exception. `beforeRun`/`afterRun` receive the same env the run uses (inherited automatically).
4. Errors inside `after`/`afterRun` are logged `warn` and do not change the run's terminal status.
5. Explicit per-command `env{}` keys reach the command even when they match the secret blacklist (e.g. `DB_PASSWORD`); inherited `process.env` / `envOverrides` / worker-profile secrets are still stripped, and they are stripped from `buildWorkerEnv` (the `env{}` bypass never touches worker envs).
6. The verify `execa` call sets `extendEnv: false`; the command unit env includes `DOCKER_*` / `COMPOSE_*` so `docker compose` hooks work.
7. `after[]` / `afterRun` use attempt-all semantics: every entry runs even when an earlier one fails, and a thrown teardown error is logged `warn` without changing the run's terminal status or skipping lease release. `afterRun` runs even when `beforeRun` throws.
8. `{issue}`/`{run}`/`{port}`/`{project}` substitute correctly in `before`/`after`/`env`; two concurrent runs (even same issue) get distinct project names, ports, and DB tokens.
9. `environment.defaultMode`/`shared`/`dedicated` and `env:shared`/`env:dedicated` labels are removed; config using them fails validation with a clear message. All other references (web dashboard types, TUI/web renderers, `config/sanitize.ts`) are updated.
10. Blocked-status comments render as separate lines; review findings appear as a bullet list.
11. `config.yaml` dailywerk profile validates and issue #341's `rails test` connects to its DB.
12. `pnpm typecheck && pnpm lint && pnpm test` pass; `docs/CONFIGURATION.md`, `docs/OVERVIEW.md`, and `examples/config.example.yaml` updated.

## Out of Scope

- Parameterizing **all** compose host ports for a repo. Only `{port}` (one port, typically the DB) is allocated per run; a compose file that publishes additional fixed host ports (cache, object store, mail) still collides across concurrent runs. Such repos must run `maxConcurrentRuns: 1` until their compose file parameterizes every published port. (dailywerk is set to 1 for this reason.)
- Per-subtask tokens under `loop.decompose: true`. Parallel decomposed subtasks currently inherit the parent run's `runTokens`, so they share `{project}`/`{port}`. Service-backed verify hooks + decomposition would collide; safe today because `decompose` is off. Per-subtask token allocation is future work.
- Hook support in preflight / post-rebase verify. Those call sites run commands via `stripVerifyHooks` (no per-run tokens exist there), so `before`/`after`/`env` are ignored; service-dependent verification only runs in the main loop.
- `envPassthrough` (forwarding named host secrets).
- Conditional/skippable stages (e.g. skip backend suite for frontend-only issues).
- Reaping orphaned stacks after SIGKILL (noted as follow-up).
- Any reintroduction of long-lived shared services.
