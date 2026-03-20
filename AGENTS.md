# Night-Orch — Codex / Agent Instructions

## Project

Node.js 24+ / TypeScript CLI tool. ESM modules. Strict TypeScript.

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

## File Organization

```
src/cli/commands/    — CLI command handlers
src/config/          — Zod schema, YAML loader
src/forge/           — ForgeAdapter + GitHub/Forgejo implementations
src/discovery/       — Issue selection, role resolution, triage
src/git/             — Branch, worktree, slug operations
src/workers/         — Agent adapters, prompt compilation, output parsing
src/loop/            — Engine, RunContext, verifier, decision, checkpointing
src/publishing/      — PR creation/update
src/labels/          — Label transitions
src/notify/          — Notification channels
src/state/           — SQLite DB, migrations
```

## Specs

Detailed implementation specs in `docs/specs-active/`. Consult the relevant phase spec before making changes.

## Commit Messages

Format: `[CATEGORY] Short imperative summary`

Categories: `[FIX]`, `[FEATURE]`, `[REFACTOR]`, `[INTERNAL]`, `[TEST]`, `[DOCS]`
