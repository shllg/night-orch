# Night-Orch — Codex Rules

## Project

Node.js 24+ / TypeScript CLI tool. ESM modules (`"type": "module"`). Strict TypeScript with `noUncheckedIndexedAccess`.

## Architecture

```
CLI → Config (Zod/YAML) → Discovery → Loop Engine → Workers → Publishing
```

- **RunContext**: Immutable context threaded through loop phases. NEVER mutate — spread-and-extend only.
- **ForgeAdapter**: Interface for GitHub/Forgejo. All forge operations go through this.
- **Workers**: External AI processes. Receive minimal env via `buildWorkerEnv()`.
- **Phase checkpointing**: Every phase writes start/complete to DB for crash recovery.
- **Metrics**: Always best-effort — never block or throw.

## Security (CRITICAL)

- **NEVER** pass forge tokens (`GITHUB_TOKEN`, `FORGEJO_TOKEN`) to worker processes
- **NEVER** pass `process.env` to workers — use `buildWorkerEnv()` with strict whitelist
- **Sanitize** issue content before prompt compilation (attacker-controlled)
- **pino redaction** for `['*.token', '*.apiKey', '*.secret', '*.password']`
- **No `console.log`** — use pino logger

## TypeScript

- ESM imports with `.js` extension: `import { foo } from './bar.js'`
- `node:` prefix for builtins: `import { readFile } from 'node:fs/promises'`
- No `any` — use `unknown` and narrow
- Handle `noUncheckedIndexedAccess`: every indexed access may be `undefined`
- Zod validation at system boundaries

## Testing

- vitest, tests in `test/` mirroring `src/`
- Mock external deps (GitHub API, git CLI, worker processes)
- Pure functions (`decide()`, `computeLabelMutation()`) tested exhaustively
- Forge contract tests parameterized for both adapters
- In-memory SQLite for DB tests

## Specs

Implementation specs in `docs/specs-active/`. Read the relevant spec before implementing.

## Code Patterns

- Label mutations: `computeLabelMutation()` (pure) → `LabelManager` (applies)
- Prompts in `workers/prompt/`, parsers in `workers/parsers/`
- Loop coordinators are thin wrappers — logic lives in prompts/parsers
- Parameterized SQL queries, WAL mode, transaction wrapping
- Structured logging with `runId`, `repo`, `issueNumber`
