# Night-Orch — Codex / Agent Instructions

## Project

Node.js 24+ / TypeScript CLI tool. ESM modules. Strict TypeScript. Runtime managed by mise (`mise.toml`, Node.js 24).

## Commands

```bash
pnpm dev <command>    # run via tsx
pnpm test             # vitest run
pnpm lint             # eslint
pnpm typecheck        # tsc --noEmit
```

## Key Rules

1. **ForgeAdapter abstraction**: All GitHub/Forgejo API calls go through `src/forge/`. Never use Octokit directly elsewhere.
2. **RunContext is immutable**: Loop steps receive context and return a new copy. Never mutate in place.
3. **Worker env isolation**: Never pass `GITHUB_TOKEN` or full `process.env` to worker subprocesses. Use `buildWorkerEnv()` from `src/workers/env.ts`.
4. **Orchestrator owns verification**: Run verify commands via `src/loop/verifier.ts`. Never trust agent output claiming tests pass.
5. **Idempotent label mutations**: Use `computeLabelMutation()` → `LabelManager.transition()`. Safe to apply multiple times.
6. **Phase checkpointing**: Write phase start/complete to SQLite before/after each loop step for crash recovery.
7. **Metrics are best-effort**: `metrics.inc*()` calls must never block or throw.
8. **Sanitize issue content**: Issue bodies are attacker-controlled. Sanitize before prompt compilation.
9. **ESM imports**: Always use `.js` extension even for `.ts` files. Always use `node:` prefix for builtins.

## File Organization

```
src/cli/commands/    — CLI command handlers
src/config/          — Zod schema, YAML loader
src/forge/           — ForgeAdapter + GitHub/Forgejo implementations
src/discovery/       — Issue selection, role resolution, triage
src/git/             — Branch, worktree, slug operations
src/environment/     — Shared/dedicated env setup, port allocation
src/workers/         — Agent adapters, prompt compilation, output parsing
src/loop/            — Engine, RunContext, verifier, decision, checkpointing
src/publishing/      — PR creation/update
src/labels/          — Label transitions
src/notify/          — Notification channels
src/mentions/        — PR mention manager
src/metrics/         — Prometheus metrics via prom-client
src/mcp/             — MCP server, tools, resources
src/ops/             — Sync, cleanup, retry engines
src/poller/          — Graceful shutdown handler
src/runner/          — Polling orchestrator
src/state/           — SQLite DB, migrations
```

## Specs

Detailed implementation specs in `docs/specs-active/`. Consult the relevant phase spec before making changes.

## React TUI Rules

- Follow `.claude/rules/08-react-tui.md` and `.codex/rules/08-react-tui.md` for React TUI structure, keybinding scoping, and state management.

## Config Documentation

Configuration authoring reference lives in `docs/CONFIGURATION.md`.
When changing config schema, config loading behavior, or config-dependent runtime behavior, update `docs/CONFIGURATION.md` in the same change.

## Commit Messages

Format: `[CATEGORY] Short imperative summary`

Categories: `[FIX]`, `[FEATURE]`, `[REFACTOR]`, `[INTERNAL]`, `[TEST]`, `[DOCS]`
