# Core Architecture Rules

These rules apply to ALL code in night-orch.

## Architecture Mental Model

```
CLI Commands → Config → Discovery → Loop Engine → Workers → Publishing
     ↓           ↓         ↓            ↓            ↓          ↓
  commander    zod/yaml  issue select  RunContext   Claude/    PR create
  arg parse    validate  role resolve  checkpoint   Codex      push
                         triage        decide()     adapters   labels
```

## MUST

- Use ESM modules — all imports use `.js` extension (even for `.ts` files)
- Enable strict TypeScript — `noUncheckedIndexedAccess` means every indexed access needs a check
- Thread `RunContext` through loop steps — each step returns a new context, never mutates
- Route all forge operations through `ForgeAdapter` — never call Octokit directly outside `forge/github.ts`
- Keep prompt logic in `workers/prompt/`, parsing in `workers/parsers/`
- Make label mutations idempotent — use `computeLabelMutation()` (pure) then apply via `LabelManager`
- Write phase checkpoints to DB for crash recovery — every loop phase writes start/complete
- Keep metrics best-effort — `metrics.inc*()` / `metrics.observe*()` must never block or throw
- Use `execa` for git operations, not `simple-git`
- Use `better-sqlite3` in WAL mode for all DB operations

## NEVER

- Mutate `RunContext` — always create a new one
- Call Octokit directly outside `forge/github.ts` or `forge/forgejo.ts`
- Import from `node:` without the `node:` prefix
- Use `require()` — ESM only
- Use `any` type — use `unknown` and narrow
- Skip error handling on DB operations
- Use `console.log` — use the pino logger
