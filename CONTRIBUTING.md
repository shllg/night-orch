# Contributing to night-orch

This guide covers local development, testing, and contribution conventions.

## Development Environment

- Node.js 24+
- `pnpm`
- `mise` (runtime/toolchain manager used by this repository)

Install dependencies:

```bash
pnpm install
```

## Local Development

Run commands via the TypeScript entrypoint:

```bash
pnpm dev <command>
```

Examples:

```bash
pnpm dev doctor
pnpm dev run
pnpm dev run-once
pnpm dev web
```

## Quality Checks

Before opening a PR, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Optional frontend and docs workflows:

```bash
pnpm web:dev
pnpm web:build
pnpm docs:dev
pnpm docs:build
pnpm storybook
pnpm storybook:build
```

## Architecture Rules

- Keep all GitHub/Forgejo API access inside `src/forge/` through the `ForgeAdapter` abstraction.
- Treat issue content as untrusted and sanitize before prompt compilation.
- Keep `RunContext` immutable across loop phases.
- Use `buildWorkerEnv()` for worker subprocess environments; never pass forge tokens.
- Run verification via orchestrator logic (`src/loop/verifier.ts`), not by trusting worker claims.

See [AGENTS.md](AGENTS.md) and [`docs/OVERVIEW.md`](docs/OVERVIEW.md) for full project rules and architecture context.

## Component Structure

Reusable UI components live in `src/components/<component-name>/`.

- Shared contracts and view-model helpers stay in the component directory.
- Platform implementations go in `*.web.tsx` and `*.tui.tsx`.
- Export each component API from a local `index.ts`.

## Commit Messages

Use this format:

```text
[CATEGORY] Short imperative summary
```

Allowed categories:

- `[FIX]`
- `[FEATURE]`
- `[REFACTOR]`
- `[INTERNAL]`
- `[TEST]`
- `[DOCS]`

## Documentation Expectations

If you change user-visible behavior, update the matching docs page in `docs/` in the same PR:

- `docs/USAGE.md`
- `docs/CONFIGURATION.md`
- `docs/OVERVIEW.md`
- `docs/deployment.md`
