# Night-Orch — Claude Code Instructions

## Project

Node.js 24+ / TypeScript CLI tool. ESM modules (`"type": "module"`). Strict TypeScript with `noUncheckedIndexedAccess`. Runtime managed by mise (`mise.toml`).

## Stack

- **CLI**: commander
- **Validation**: zod
- **Config**: yaml (YAML parsing)
- **GitHub/Forgejo**: @octokit/rest + ForgeAdapter abstraction
- **Git**: execa (direct git CLI, not simple-git)
- **DB**: better-sqlite3 (WAL mode)
- **Logging**: pino (with token redaction)
- **MCP**: @modelcontextprotocol/sdk
- **Metrics**: prom-client
- **Testing**: vitest (explicit imports, not globals)
- **Linting**: eslint

## Commands

```bash
mise run dev          # night-orch + monitoring stack (Prometheus + Grafana)
mise run dev-solo     # night-orch only, no monitoring
mise run run-once     # single poll cycle
mise run doctor       # validate config, auth, CLIs, repos, DB
mise run status       # show active runs, recent history, costs
mise run labels-init  # create/update GitHub labels from config

pnpm test             # vitest run
pnpm lint             # eslint
pnpm typecheck        # tsc --noEmit
```

## Critical Conventions

- **ESM imports**: Always `.js` extension even for `.ts` files: `import { x } from './y.js'`
- **Node builtins**: Always `node:` prefix: `import { x } from 'node:fs/promises'`
- **No `any`**: Use `unknown` and narrow with type guards

## Commit Messages

Format: `[CATEGORY] Short imperative summary`

Categories: `[FIX]`, `[FEATURE]`, `[REFACTOR]`, `[INTERNAL]`, `[TEST]`, `[DOCS]`

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
src/poller/          — Graceful shutdown handler
src/runner/          — Polling orchestrator
src/state/           — SQLite DB, migrations, leases, runs
src/utils/           — Logger, IDs, time helpers
```

## Specs

Implementation specs in `docs/specs-active/`. Consult the relevant phase spec before implementing.

## Extended Rules

Domain-specific rules are in `.claude/rules/` — architecture, security, TypeScript, loop engine, testing, specs, and operational patterns. These are loaded automatically when relevant.
