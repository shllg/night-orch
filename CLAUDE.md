# Night-Orch — Claude Code Instructions

## Project

Node.js 24+ / TypeScript CLI tool. ESM modules (`"type": "module"`). Strict TypeScript with `noUncheckedIndexedAccess`.

## Stack

- **CLI**: commander
- **Validation**: zod
- **Config**: yaml (YAML parsing)
- **GitHub/Forgejo**: @octokit/rest + ForgeAdapter abstraction
- **Git**: execa (direct git CLI, not simple-git)
- **DB**: better-sqlite3 (WAL mode)
- **Logging**: pino (with token redaction)
- **Testing**: vitest
- **Linting**: eslint

## Commands

```bash
pnpm dev <command>    # run via tsx
pnpm test             # vitest run
pnpm lint             # eslint
pnpm typecheck        # tsc --noEmit
```

## Code Patterns

- **RunContext**: Immutable context object threaded through loop steps. Each step returns a new context. Never mutate.
- **ForgeAdapter**: Interface for GitHub/Forgejo. All forge operations go through this — never call Octokit directly outside `forge/github.ts`.
- **Loop coordinators** (`loop/planner.ts`, `loop/coder.ts`, `loop/reviewer.ts`): Thin wrappers that compile prompts and call worker adapters. Keep prompt logic in `workers/prompt/`, parsing in `workers/parsers/`.
- **Label mutations**: Always idempotent. Use `computeLabelMutation()` (pure function) then apply via `LabelManager`.
- **Phase checkpointing**: Every loop phase writes start/complete to DB for crash recovery.
- **Metrics**: Always best-effort. `metrics.inc*()` / `metrics.observe*()` calls must never block or throw.

## Security Rules

- **Never pass `GITHUB_TOKEN`** (or any forge token) to worker processes. Workers get a minimal env whitelist.
- **Never pass full `process.env`** to workers. Use `buildWorkerEnv()`.
- **Sanitize issue content** before prompt compilation — it's attacker-controlled.
- **pino redaction** configured for `['*.token', '*.apiKey', '*.secret']`.

## File Organization

```
src/cli/commands/    — CLI command handlers
src/config/          — Zod schema, YAML loader, path expansion
src/forge/           — ForgeAdapter interface + GitHub/Forgejo implementations
src/discovery/       — Issue selection, role resolution, triage
src/git/             — Branch, worktree, slug, repo operations
src/environment/     — Shared/dedicated env setup, port allocation
src/workers/         — Claude/Codex adapters, prompt compilation, output parsing
src/loop/            — Engine, RunContext, verifier, decision, checkpointing
src/publishing/      — PR creation/update, push
src/labels/          — Label transition logic
src/notify/          — Notification channels and dispatcher
src/mentions/        — PR mention manager
src/metrics/         — Prometheus metrics via prom-client
src/mcp/             — MCP server, tools, resources
src/ops/             — Sync, cleanup, retry engines
src/state/           — SQLite DB, migrations, leases, runs
src/utils/           — Logger, IDs, time helpers
```

## Specs

Implementation specs are in `docs/specs-active/`. Each phase has a detailed spec with interfaces, files to create, tests, and acceptance criteria. Consult the relevant phase spec before implementing.

## Testing

- Use vitest. Tests live in `test/` mirroring `src/` structure.
- Mock external dependencies (GitHub API, git CLI, worker processes).
- Forge contract tests (`test/forge/contract.test.ts`) are parameterized — both GitHub and Forgejo adapters must pass the same suite.
- `decide()` and `computeLabelMutation()` are pure functions — test exhaustively.
