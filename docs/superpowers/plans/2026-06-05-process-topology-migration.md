# Process Topology Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate night-orch from a single Node package into a 5-package pnpm workspace (`shared`, `backend`, `web`, `runner`, `cli`) and split the running system into separate `runner → backend + web` processes, per `docs/superpowers/specs/2026-06-05-process-topology-ipc-design.md`.

**Architecture:** Bottom-up refactor — first carve out `shared` (zero-runtime-dep pure code + zod schemas + types), then move existing modules into `backend`/`runner`/`web` packages without behavior change, then flip the process model so `runner` forks `backend` + `web` as separate Node processes communicating over loopback HTTP + fork IPC. Every migration step is independently shippable and reversible by a single revert.

**Tech Stack:** Node 24 / TypeScript / ESM with `.js` extensions, pnpm workspaces with TS project references, vitest, eslint flat config, zod, `node:child_process.fork`, native `fetch` + `EventSource` (undici/Node 24 built-ins).

**Reference spec:** `docs/superpowers/specs/2026-06-05-process-topology-ipc-design.md` (must be read before starting).

---

## File Structure (target after all migrations)

```
pnpm-workspace.yaml            ← workspace glob
tsconfig.base.json             ← shared tsconfig (extends in each pkg)
tsconfig.json                  ← references all packages
eslint.config.js               ← per-package overrides incl. shared purity rule
packages/
  shared/
    package.json               ← name: @night-orch/shared, private: true
    tsconfig.json              ← extends base, outDir dist
    src/
      index.ts                 ← barrel — re-exports everything below
      types/                   ← domain models (Run, Issue, Lease, …)
      schemas/                 ← zod schemas for config, IPC, events
      logic/                   ← decide, computeLabelMutation, parsers, prompt compile
      constants/               ← event names, error codes, default ports
    test/                      ← vitest specs colocated by topic
  backend/
    package.json               ← @night-orch/backend
    tsconfig.json
    src/
      index.ts                 ← bin entry: starts engine + HTTP api + MCP
      state/  forge/  workers/  loop/  poller/  discovery/  mentions/
      reactions/  publishing/  labels/  notify/  metrics/  ops/  git/
      environment/  mcp/  http/  events/  config/
    test/
  web/
    package.json               ← @night-orch/web
    src/
      bin.ts                   ← entry: HTTP server + reverse-proxy + static
      proxy.ts                 ← reverse-proxy logic
      static.ts                ← SPA static asset serving
      spa/                     ← React app (was top-level web/)
    test/
  runner/
    package.json               ← @night-orch/runner
    src/
      index.ts                 ← supervisor entry
      supervisor.ts            ← fork children, restart FSM
      health-probe.ts          ← /health polling
      ipc.ts                   ← fork-IPC command/event envelope helpers
      update-fsm.ts            ← staged update placeholder (filled by follow-up spec)
    test/
  cli/
    package.json               ← name: night-orch (the published bin)
    src/
      index.ts                 ← argv dispatch
      commands/                ← run, doctor, status, sync, tui, …
      tui/                     ← React-ink screens (HTTP client of backend)
    test/
```

**Decomposition rationale:**
- `shared/` cannot import any other internal package or any I/O lib (enforced by ESLint). Splits by topic (types/schemas/logic/constants) inside the package, not by package.
- `backend/` keeps existing folder layout (state, forge, workers, loop, …) — moving folders verbatim avoids huge import-graph churn.
- `web/` separates server logic (`proxy.ts`, `static.ts`, `bin.ts`) from SPA bundle (`spa/`).
- `runner/` carves supervisor responsibilities into 4 narrow files (target: each ≤ 250 LOC).
- `cli/` shrinks to a thin argv router + a `tui/` folder; `tui/` will move to its own package later when its surface stops churning.

---

## Plan organization

8 migrations, each a contiguous block of tasks. Within a migration, tasks are TDD-shaped for new code and move-and-verify shaped for refactors. **Every migration ends with one commit and a passing `pnpm typecheck && pnpm lint && pnpm test` run.** Each migration is reviewable + revertable independently.

| Migration | Theme | Tasks |
|-----------|-------|-------|
| M1 | Workspace skeleton + `@night-orch/shared` package | 12 |
| M2 | Extract `@night-orch/backend` | 9 |
| M3 | Extract `@night-orch/runner` | 4 |
| M4 | Extract `@night-orch/web` | 5 |
| M5 | Web becomes reverse-proxy + runner forks separate processes | 8 |
| M6 | Formalize `@night-orch/shared` as IPC contract source | 6 |
| M7 | TUI extraction + HTTP rewire | 6 |
| M8 | Health endpoint formalization | 5 |

---

# M1 — Workspace skeleton + `@night-orch/shared`

Goal: add pnpm workspace, create `packages/shared/`, move pure-fn modules and schemas into it, keep all existing imports working via barrel re-exports. End state: same single process, same behavior, but pure code lives in its own package and a purity lint rule passes.

### Task 1.1: Add pnpm workspace + base tsconfig

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Modify: `package.json` (root) — add `"workspaces"` for tooling that reads it, add `"pnpm"` block

- [ ] **Step 1: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 2: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2024"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "composite": true,
    "jsx": "react-jsx"
  }
}
```

- [ ] **Step 3: Run pnpm install to materialize workspace metadata**

Run: `pnpm install`
Expected: completes, prints `Already up to date` or installs deps; no errors.

- [ ] **Step 4: Verify project still builds**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml tsconfig.base.json package.json
git commit -m "[REFACTOR] Add pnpm workspace skeleton + base tsconfig"
```

### Task 1.2: Create `packages/shared/` skeleton

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/test/.gitkeep`

- [ ] **Step 1: Write `packages/shared/package.json`**

```json
{
  "name": "@night-orch/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "workspace:*"
  }
}
```

Note: `zod` workspace-protocol resolves to the version already pinned in the root `package.json`. If pnpm complains, replace `workspace:*` with the exact pinned version from root.

- [ ] **Step 2: Write `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "test"]
}
```

- [ ] **Step 3: Write `packages/shared/src/index.ts`**

```typescript
export {}
```

(Empty barrel — populated as we move modules in.)

- [ ] **Step 4: Build the empty package**

Run: `pnpm --filter @night-orch/shared build`
Expected: produces `packages/shared/dist/index.js` + `.d.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "[REFACTOR] Create @night-orch/shared package skeleton"
```

### Task 1.3: Wire `@night-orch/shared` into root + add to project references

**Files:**
- Modify: root `package.json` — add `"@night-orch/shared": "workspace:*"` to `dependencies`
- Modify: root `tsconfig.json` — add `references` block

- [ ] **Step 1: Add workspace dep in root `package.json`**

Add to `dependencies`:

```json
"@night-orch/shared": "workspace:*"
```

- [ ] **Step 2: Update root `tsconfig.json`**

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "references": [
    { "path": "./packages/shared" }
  ],
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist", "test", "src/**/*.stories.tsx"]
}
```

- [ ] **Step 3: Install + typecheck**

Run: `pnpm install && pnpm typecheck`
Expected: typecheck passes. If it fails because of `composite: true` on root, set root `composite: false` and keep it on `packages/*` only.

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json pnpm-lock.yaml
git commit -m "[REFACTOR] Reference @night-orch/shared from root tsconfig + package.json"
```

### Task 1.4: Add purity ESLint rule for `shared`

**Files:**
- Modify: `eslint.config.js`

- [ ] **Step 1: Add a new block restricting imports inside `packages/shared/**`**

Append this block to the `tseslint.config(...)` array in `eslint.config.js`, after the existing `web/src/**` block:

```javascript
{
  files: ['packages/shared/**/*.ts'],
  languageOptions: {
    parserOptions: {
      project: './packages/shared/tsconfig.json',
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['better-sqlite3', 'better-sqlite3/*'], message: 'shared must stay I/O-free — no DB imports.' },
        { group: ['@octokit/*'], message: 'shared must stay I/O-free — no forge SDK imports.' },
        { group: ['execa', 'execa/*'], message: 'shared must stay I/O-free — no shell/process imports.' },
        { group: ['chokidar'], message: 'shared must stay I/O-free — no filesystem watchers.' },
        { group: ['pino', 'pino/*', 'pino-pretty'], message: 'shared must stay I/O-free — no logger.' },
        { group: ['node:fs', 'node:fs/*'], message: 'shared must stay I/O-free — no filesystem.' },
        { group: ['node:net', 'node:http', 'node:https', 'node:tls', 'node:dgram'], message: 'shared must stay I/O-free — no network.' },
        { group: ['node:child_process', 'node:cluster', 'node:worker_threads'], message: 'shared must stay I/O-free — no process control.' },
        { group: ['node:dns'], message: 'shared must stay I/O-free — no DNS.' },
        { group: ['@night-orch/*'], message: 'shared cannot import other internal packages.' },
      ],
    }],
  },
},
```

- [ ] **Step 2: Add the new tsconfig path to `tsconfig.eslint.json`**

If `tsconfig.eslint.json` lists project paths, add `./packages/shared/tsconfig.json` to its `references` list. If it doesn't exist as a project-references file, no action — the per-block `parserOptions.project` line above is sufficient.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: passes (shared/src/index.ts is empty, no violations).

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js tsconfig.eslint.json
git commit -m "[REFACTOR] Enforce purity of @night-orch/shared via ESLint no-restricted-imports"
```

### Task 1.5: Move shared domain TYPES into `shared/src/types/`

Goal: move only pure type definitions (no zod, no runtime). Touch:

- `src/loop/types.ts` (RunContext, LoopDecision, RunPhase)
- `src/state/types.ts` (if exists — Run, Lease, Checkpoint domain models)
- Any cross-process model types currently inlined in `src/web/routes/*` or similar

**Files:**
- Create: `packages/shared/src/types/loop.ts` (from `src/loop/types.ts`)
- Create: `packages/shared/src/types/state.ts` (from `src/state/*` type-only exports)
- Create: `packages/shared/src/types/index.ts` (barrel)
- Modify: `packages/shared/src/index.ts` — re-export `./types/index.js`
- Modify: `src/loop/types.ts` — replace contents with `export * from '@night-orch/shared'` for moved symbols
- Modify: all internal consumers — no change yet (barrel redirects)

- [ ] **Step 1: Copy `src/loop/types.ts` to `packages/shared/src/types/loop.ts`**

```bash
mkdir -p packages/shared/src/types
git mv src/loop/types.ts packages/shared/src/types/loop.ts
```

- [ ] **Step 2: Edit the moved file — strip any non-type runtime code**

Open `packages/shared/src/types/loop.ts`. Remove any imports of non-type modules. Convert any non-type-only imports to `import type`. If a runtime const is needed, move it to step 6 (constants).

- [ ] **Step 3: Write `packages/shared/src/types/index.ts`**

```typescript
export type * from './loop.js'
```

(Add more lines as more type files arrive.)

- [ ] **Step 4: Update `packages/shared/src/index.ts`**

```typescript
export type * from './types/index.js'
```

- [ ] **Step 5: Recreate `src/loop/types.ts` as a barrel**

```typescript
// Backwards-compat barrel — types now live in @night-orch/shared.
// Delete this file when all internal imports are migrated.
export type * from '@night-orch/shared'
```

- [ ] **Step 6: Build shared + typecheck root**

Run: `pnpm --filter @night-orch/shared build && pnpm typecheck`
Expected: passes. If specific types are now missing, repeat steps 1–4 for the missing types (search by name in `src/` to find the source of truth).

- [ ] **Step 7: Run tests**

Run: `pnpm test`
Expected: passes.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types packages/shared/src/index.ts src/loop/types.ts
git commit -m "[REFACTOR] Move loop + state type defs into @night-orch/shared"
```

### Task 1.6: Move zod CONFIG schemas into `shared/src/schemas/`

Goal: `src/config/schema.ts` is the authoritative zod source. Move it to `packages/shared/src/schemas/config.ts`.

**Files:**
- Create: `packages/shared/src/schemas/config.ts` (from `src/config/schema.ts`)
- Create: `packages/shared/src/schemas/index.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `src/config/schema.ts` — becomes barrel

- [ ] **Step 1: Move the file**

```bash
mkdir -p packages/shared/src/schemas
git mv src/config/schema.ts packages/shared/src/schemas/config.ts
```

- [ ] **Step 2: Verify imports in the moved file are still I/O-free**

Open `packages/shared/src/schemas/config.ts`. Must only import `zod` and other shared modules. If it imports `node:path` or anything I/O-shaped, leave those in `src/config/loader.ts` (which stays in `src/`).

- [ ] **Step 3: Write `packages/shared/src/schemas/index.ts`**

```typescript
export * from './config.js'
```

- [ ] **Step 4: Update `packages/shared/src/index.ts`**

```typescript
export type * from './types/index.js'
export * from './schemas/index.js'
```

- [ ] **Step 5: Recreate `src/config/schema.ts` as barrel**

```typescript
export * from '@night-orch/shared'
```

- [ ] **Step 6: Build + typecheck + test**

Run: `pnpm --filter @night-orch/shared build && pnpm typecheck && pnpm test`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas packages/shared/src/index.ts src/config/schema.ts
git commit -m "[REFACTOR] Move zod config schemas into @night-orch/shared"
```

### Task 1.7: Move `decide()` into `shared/src/logic/`

Goal: pure loop decision function moves to `shared`. It is the canonical pure-fn target per spec D5 and project rules.

**Files:**
- Create: `packages/shared/src/logic/decide.ts` (from `src/loop/decision.ts`)
- Create: `packages/shared/src/logic/index.ts`
- Create: `packages/shared/test/logic/decide.test.ts` (move existing test from `test/loop/decision.test.ts` if present)
- Modify: `packages/shared/src/index.ts`
- Modify: `src/loop/decision.ts` — barrel

- [ ] **Step 1: Inspect current `src/loop/decision.ts` for non-pure deps**

Run: `head -20 src/loop/decision.ts`
Expected: confirm only type/pure imports. If it imports anything I/O (logger, DB), STOP and refactor those out first (extract pure core into a smaller function).

- [ ] **Step 2: Move the file**

```bash
mkdir -p packages/shared/src/logic
git mv src/loop/decision.ts packages/shared/src/logic/decide.ts
```

- [ ] **Step 3: Update imports in the moved file**

Replace any relative `import … from '../config/schema.js'` with `import … from '@night-orch/shared'` (since schema now lives there). Same for type imports of moved types.

- [ ] **Step 4: Write `packages/shared/src/logic/index.ts`**

```typescript
export * from './decide.js'
```

- [ ] **Step 5: Update `packages/shared/src/index.ts`**

```typescript
export type * from './types/index.js'
export * from './schemas/index.js'
export * from './logic/index.js'
```

- [ ] **Step 6: Recreate `src/loop/decision.ts` as barrel**

```typescript
export * from '@night-orch/shared'
```

- [ ] **Step 7: Move tests if present**

```bash
mkdir -p packages/shared/test/logic
[ -f test/loop/decision.test.ts ] && git mv test/loop/decision.test.ts packages/shared/test/logic/decide.test.ts || echo "no existing test"
```

If moved: update import paths in the test from relative `../../src/loop/decision.js` to `../../src/logic/decide.js`.

- [ ] **Step 8: Add a smoke vitest config for `shared` if not inherited**

Create `packages/shared/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: false,
  },
})
```

- [ ] **Step 9: Build + typecheck + test (root + shared)**

Run: `pnpm --filter @night-orch/shared build && pnpm --filter @night-orch/shared test && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/shared src/loop/decision.ts test/loop 2>/dev/null
git commit -m "[REFACTOR] Move decide() into @night-orch/shared/logic"
```

### Task 1.8: Move label mutation into `shared/src/logic/`

Goal: `computeLabelMutation` is pure per project rules — moves to shared.

**Files:**
- Identify source file by `grep -rl "computeLabelMutation" src/labels/`
- Create: `packages/shared/src/logic/label-mutation.ts`
- Modify: `packages/shared/src/logic/index.ts`
- Move test if present

- [ ] **Step 1: Find the function**

Run: `grep -rln "export function computeLabelMutation\|export const computeLabelMutation" src/labels/`
Expected: prints one file path (likely `src/labels/transitions.ts`).

- [ ] **Step 2: Identify what else lives in that file**

Run: `head -30 <found-path>`
Expected: shows imports. If the file mixes pure + I/O code, extract `computeLabelMutation` (and any pure helpers it calls) into a new pure file first.

- [ ] **Step 3: Extract pure function to `packages/shared/src/logic/label-mutation.ts`**

If the file is purely pure: `git mv <path> packages/shared/src/logic/label-mutation.ts`.

If mixed: copy only the pure exports to the new file. Replace the original exports with `export { computeLabelMutation } from '@night-orch/shared'`.

- [ ] **Step 4: Update `packages/shared/src/logic/index.ts`**

```typescript
export * from './decide.js'
export * from './label-mutation.js'
```

- [ ] **Step 5: Move tests**

```bash
[ -f test/labels/transitions.test.ts ] && git mv test/labels/transitions.test.ts packages/shared/test/logic/label-mutation.test.ts || true
```

Update test imports if needed.

- [ ] **Step 6: Build + typecheck + test**

Run: `pnpm --filter @night-orch/shared build && pnpm --filter @night-orch/shared test && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared src/labels test/labels 2>/dev/null
git commit -m "[REFACTOR] Move computeLabelMutation into @night-orch/shared/logic"
```

### Task 1.9: Move worker output parsers into `shared/src/logic/`

Goal: `src/workers/parsers/` is pure per project rules.

**Files:**
- Move tree: `src/workers/parsers/` → `packages/shared/src/logic/parsers/`
- Tests: `test/workers/parsers/` → `packages/shared/test/logic/parsers/`

- [ ] **Step 1: Inspect parsers for I/O**

Run: `grep -rE "import.*node:fs|import.*pino|import.*execa" src/workers/parsers/`
Expected: empty. If non-empty, refactor I/O out before moving.

- [ ] **Step 2: Move the tree**

```bash
git mv src/workers/parsers packages/shared/src/logic/parsers
[ -d test/workers/parsers ] && git mv test/workers/parsers packages/shared/test/logic/parsers || true
```

- [ ] **Step 3: Update import paths in moved files**

Run: `grep -rln "from '\.\./\.\./" packages/shared/src/logic/parsers/` and fix each. Most likely need to point to `@night-orch/shared` (for types) or stay relative within the package.

- [ ] **Step 4: Add an index barrel for parsers**

`packages/shared/src/logic/parsers/index.ts`:

```typescript
// Re-export every parser from this folder. Replace the list below with the actual files.
export * from './worker-output.js'
// add more as files exist
```

(Inspect the directory first: `ls packages/shared/src/logic/parsers/` and add a re-export line per file that has exports.)

- [ ] **Step 5: Update `packages/shared/src/logic/index.ts`**

```typescript
export * from './decide.js'
export * from './label-mutation.js'
export * from './parsers/index.js'
```

- [ ] **Step 6: Create barrel at old location**

`src/workers/parsers/index.ts`:

```typescript
export * from '@night-orch/shared'
```

- [ ] **Step 7: Build + typecheck + test**

Run: `pnpm --filter @night-orch/shared build && pnpm --filter @night-orch/shared test && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/shared src/workers test/workers 2>/dev/null
git commit -m "[REFACTOR] Move worker output parsers into @night-orch/shared/logic"
```

### Task 1.10: Move prompt compilers into `shared/src/logic/`

Goal: `src/workers/prompt/` is pure (templates + assembly) per project rules.

**Files:**
- Move: `src/workers/prompt/` → `packages/shared/src/logic/prompt/`
- Tests: `test/workers/prompt/` if exists

- [ ] **Step 1: Inspect for I/O**

Run: `grep -rE "import.*node:fs|import.*pino|import.*execa|@octokit" src/workers/prompt/`
Expected: empty. If template loading uses `node:fs`, leave the loader in `src/` and only move the pure assembly function.

- [ ] **Step 2: Move the tree**

```bash
git mv src/workers/prompt packages/shared/src/logic/prompt
[ -d test/workers/prompt ] && git mv test/workers/prompt packages/shared/test/logic/prompt || true
```

- [ ] **Step 3: Add `packages/shared/src/logic/prompt/index.ts`** if not already present, re-exporting all module entrypoints.

- [ ] **Step 4: Update `packages/shared/src/logic/index.ts`**

```typescript
export * from './decide.js'
export * from './label-mutation.js'
export * from './parsers/index.js'
export * from './prompt/index.js'
```

- [ ] **Step 5: Create barrel at old location**

`src/workers/prompt/index.ts`:

```typescript
export * from '@night-orch/shared'
```

- [ ] **Step 6: Build + typecheck + test**

Run: `pnpm --filter @night-orch/shared build && pnpm --filter @night-orch/shared test && pnpm typecheck && pnpm test`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add packages/shared src/workers test/workers 2>/dev/null
git commit -m "[REFACTOR] Move prompt compilers into @night-orch/shared/logic"
```

### Task 1.11: Add shared constants

**Files:**
- Create: `packages/shared/src/constants/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write `packages/shared/src/constants/index.ts`**

```typescript
export const PROCESS_NAMES = ['runner', 'backend', 'web'] as const
export type ProcessName = typeof PROCESS_NAMES[number]

export const SSE_EVENT_NAMES = [
  'run.started',
  'run.phase_complete',
  'run.completed',
  'run.failed',
  'issue.discovered',
  'health.changed',
  'maintenance.changed',
] as const
export type SseEventName = typeof SSE_EVENT_NAMES[number]

export const ERROR_CODES = {
  unauthenticated: 'E_UNAUTHENTICATED',
  forbidden: 'E_FORBIDDEN',
  notFound: 'E_NOT_FOUND',
  validation: 'E_VALIDATION',
  maintenance: 'E_MAINTENANCE',
  internal: 'E_INTERNAL',
} as const
export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES]

export const DEFAULT_PORTS = {
  web: 3200,
  backendLoopback: 0, // 0 = kernel-assigned; written to <dataDir>/backend.port
  mcpHttp: 3210,
} as const
```

- [ ] **Step 2: Update `packages/shared/src/index.ts`**

```typescript
export type * from './types/index.js'
export * from './schemas/index.js'
export * from './logic/index.js'
export * from './constants/index.js'
```

- [ ] **Step 3: Build + typecheck + lint + test**

Run: `pnpm --filter @night-orch/shared build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/shared
git commit -m "[REFACTOR] Add shared constants (process names, event names, error codes, default ports)"
```

### Task 1.12: M1 acceptance check

- [ ] **Step 1: Run full verification**

Run: `pnpm install && pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 2: Run the dev CLI to confirm behavior unchanged**

Run: `pnpm dev doctor`
Expected: exits 0, prints expected validation output. (Use `doctor` because it loads config and exercises the whole import graph without side-effects on real repos.)

- [ ] **Step 3: Verify shared purity rule is active**

Run: `node -e "console.log('purity check via lint')" && pnpm lint --max-warnings 0`
Expected: passes. Manually add a violating import to `packages/shared/src/index.ts` (e.g. `import 'better-sqlite3'`), run `pnpm lint`, confirm it errors with the expected message, then revert.

- [ ] **Step 4: Confirm git log shows clean per-task commits**

Run: `git log --oneline -15`
Expected: tasks 1.1–1.11 each as one commit (~11 commits). No mixed-concern commits.

- [ ] **Step 5: No additional commit — M1 already committed task-by-task.**

---

# M2 — Extract `@night-orch/backend`

Goal: move all engine / DB / forge / workers / HTTP route / MCP code into `packages/backend/`. Single process still. Barrel re-exports at old `src/` paths during migration. End state: `src/` only contains the CLI entry + barrels.

**Heuristic for what stays in `src/` (cli) vs. what moves to `backend`:**
- `src/cli/**` — stays in `src/` (later becomes `packages/cli/`)
- everything else under `src/` — moves to `packages/backend/src/`

### Task 2.1: Create `@night-orch/backend` skeleton

**Files:**
- Create: `packages/backend/package.json`
- Create: `packages/backend/tsconfig.json`
- Create: `packages/backend/src/index.ts`

- [ ] **Step 1: Write `packages/backend/package.json`**

```json
{
  "name": "@night-orch/backend",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./*": "./dist/*.js"
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@night-orch/shared": "workspace:*"
  }
}
```

Add runtime deps (copy from root `package.json`): `better-sqlite3`, `@octokit/rest`, `execa`, `pino`, `chokidar`, `commander`, `yaml`, `prom-client`, `@modelcontextprotocol/sdk`. Use the same pinned versions as root.

- [ ] **Step 2: Write `packages/backend/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "references": [
    { "path": "../shared" }
  ],
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "test"]
}
```

- [ ] **Step 3: Write a placeholder `packages/backend/src/index.ts`**

```typescript
export {}
```

- [ ] **Step 4: Reference backend from root tsconfig**

Update root `tsconfig.json` `references` to include `{ "path": "./packages/backend" }`.

- [ ] **Step 5: Install + build**

Run: `pnpm install && pnpm --filter @night-orch/backend build`
Expected: backend builds (empty).

- [ ] **Step 6: Commit**

```bash
git add packages/backend tsconfig.json package.json pnpm-lock.yaml
git commit -m "[REFACTOR] Create @night-orch/backend package skeleton"
```

### Task 2.2: Move `state/` + `forge/`

**Files:**
- Move: `src/state/` → `packages/backend/src/state/`
- Move: `src/forge/` → `packages/backend/src/forge/`
- Tests: corresponding `test/state/`, `test/forge/` → `packages/backend/test/`

- [ ] **Step 1: Move the trees**

```bash
git mv src/state packages/backend/src/state
git mv src/forge packages/backend/src/forge
mkdir -p packages/backend/test
[ -d test/state ] && git mv test/state packages/backend/test/state || true
[ -d test/forge ] && git mv test/forge packages/backend/test/forge || true
```

- [ ] **Step 2: Bulk-update import paths in moved files**

Run a sed sweep to point any `../config/schema.js` / etc. references at `@night-orch/shared` if they reference moved schemas/types:

```bash
grep -rln "from '\.\./config/schema\.js'\|from '\.\./\.\./config/schema\.js'" packages/backend/src/state packages/backend/src/forge | xargs -r sed -i "s|from '\.\./config/schema\.js'|from '@night-orch/shared'|g; s|from '\.\./\.\./config/schema\.js'|from '@night-orch/shared'|g"
```

- [ ] **Step 3: Add `packages/backend/src/index.ts` barrel exports**

```typescript
export * from './state/index.js'
export * from './forge/index.js'
```

(Only export modules that actually have an `index.ts`. Otherwise re-export specific files explicitly. Inspect `packages/backend/src/state/` to confirm.)

- [ ] **Step 4: Create barrels at old paths for source-compat**

Create `src/state/index.ts`:

```typescript
export * from '@night-orch/backend'
```

Same for `src/forge/index.ts`. (Recreate the file — `git mv` removed it.)

- [ ] **Step 5: Add a `packages/backend/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: false,
  },
})
```

- [ ] **Step 6: Build + typecheck + test**

Run: `pnpm --filter @night-orch/backend build && pnpm typecheck && pnpm test`
Expected: all pass. If imports are missing, search for the symbol with `grep -rln "<symbol>" packages/backend/src/` and add to the barrel.

- [ ] **Step 7: Commit**

```bash
git add packages/backend src/state src/forge
git commit -m "[REFACTOR] Move state + forge into @night-orch/backend"
```

### Task 2.3: Move `loop/` + `workers/` (minus already-moved pure modules)

**Files:**
- Move: `src/loop/` → `packages/backend/src/loop/`
- Move: `src/workers/` → `packages/backend/src/workers/`
- Tests: `test/loop/`, `test/workers/`

- [ ] **Step 1: Move trees**

```bash
git mv src/loop packages/backend/src/loop
git mv src/workers packages/backend/src/workers
[ -d test/loop ] && git mv test/loop packages/backend/test/loop || true
[ -d test/workers ] && git mv test/workers packages/backend/test/workers || true
```

- [ ] **Step 2: Fix imports of moved-to-shared modules**

```bash
grep -rln "@night-orch/shared'\|from '\.\./types\.js'" packages/backend/src/loop packages/backend/src/workers | head
```

If files import `./types.js` (which is now the barrel), they still work. No changes needed unless a deep import is broken — fix individually.

- [ ] **Step 3: Update backend `index.ts` barrel**

```typescript
export * from './state/index.js'
export * from './forge/index.js'
export * from './loop/index.js'
export * from './workers/index.js'
```

(Confirm those `index.ts` exist or substitute the actual entry points.)

- [ ] **Step 4: Create barrels at `src/loop/index.ts`, `src/workers/index.ts`** redirecting to `@night-orch/backend`. Keep the existing `src/loop/types.ts` and `src/loop/decision.ts` barrels — they redirect to `@night-orch/shared`.

- [ ] **Step 5: Build + typecheck + test**

Run: `pnpm --filter @night-orch/backend build && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/backend src/loop src/workers test 2>/dev/null
git commit -m "[REFACTOR] Move loop + workers into @night-orch/backend"
```

### Task 2.4: Move `poller/`, `discovery/`, `runner/` (orchestration)

**Files:**
- Move: `src/poller/`, `src/discovery/`, `src/runner/` → `packages/backend/src/`

Note: `src/runner/` here is the *poller-runner* orchestrator (contains `poller.ts`, `comment-commands.ts`, …) — **not** the new supervisor `packages/runner/`. We will rename it on the way in to avoid name collision.

- [ ] **Step 1: Rename `src/runner/` on move to avoid collision with `packages/runner/`**

```bash
git mv src/poller packages/backend/src/poller
git mv src/discovery packages/backend/src/discovery
git mv src/runner packages/backend/src/orchestration
```

`orchestration/` is the new name inside backend. The supervisor lives in `packages/runner/` (M3).

- [ ] **Step 2: Move corresponding tests**

```bash
[ -d test/poller ] && git mv test/poller packages/backend/test/poller || true
[ -d test/discovery ] && git mv test/discovery packages/backend/test/discovery || true
[ -d test/runner ] && git mv test/runner packages/backend/test/orchestration || true
```

- [ ] **Step 3: Fix any imports of old `src/runner/` path**

```bash
grep -rln "from '.*runner/\(poller\|comment-commands\|comment-formatting\|intent\|orchestration-cache\|reaction-scan\|run-finalizer\|workflow-overlay\)\.js'" packages/backend/src | xargs -r sed -i "s|/runner/|/orchestration/|g"
```

Same sweep for `src/` (in case CLI imports them):

```bash
grep -rln "from '.*src/runner/" src | xargs -r sed -i "s|/src/runner/|/src/orchestration/|g"
```

- [ ] **Step 4: Update backend `index.ts` barrel**

```typescript
export * from './state/index.js'
export * from './forge/index.js'
export * from './loop/index.js'
export * from './workers/index.js'
export * from './poller/index.js'
export * from './discovery/index.js'
export * from './orchestration/index.js'
```

- [ ] **Step 5: Build + typecheck + test**

Run: `pnpm --filter @night-orch/backend build && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/backend src test 2>/dev/null
git commit -m "[REFACTOR] Move poller, discovery, orchestration into @night-orch/backend"
```

### Task 2.5: Move remaining engine modules

**Files:**
- Move: `src/mentions/`, `src/reactions/`, `src/publishing/`, `src/labels/`, `src/notify/`, `src/metrics/`, `src/ops/`, `src/git/`, `src/environment/`, `src/merge-queue/`, `src/planning/`, `src/work-items/`, `src/fileloop/`, `src/events/`, `src/settings/`, `src/ai/`, `src/components/` (if used by backend HTTP layer) → `packages/backend/src/`

- [ ] **Step 1: List remaining src dirs**

Run: `ls src/`
Expected: shows the directories still in `src/`. Anything that is NOT `cli/` or a barrel should move.

- [ ] **Step 2: Move each remaining dir (except cli)**

```bash
for d in mentions reactions publishing labels notify metrics ops git environment merge-queue planning work-items fileloop events settings ai components; do
  [ -d "src/$d" ] && git mv "src/$d" "packages/backend/src/$d" || true
  [ -d "test/$d" ] && git mv "test/$d" "packages/backend/test/$d" || true
done
```

- [ ] **Step 3: Move `src/utils/` to backend**

```bash
git mv src/utils packages/backend/src/utils
[ -d test/utils ] && git mv test/utils packages/backend/test/utils || true
```

(`utils/logger.ts` and similar are I/O-bearing; they belong in `backend`. Pure helpers were already extracted to `shared` if any existed.)

- [ ] **Step 4: Move `src/config/` (loader + paths + sanitize)**

```bash
git mv src/config packages/backend/src/config
[ -d test/config ] && git mv test/config packages/backend/test/config || true
```

The schema barrel at the old path is now broken — recreate `src/config/schema.ts` re-exporting from `@night-orch/shared`. Also create `src/config/index.ts` re-exporting from `@night-orch/backend`.

- [ ] **Step 5: Update backend `index.ts` to export all moved modules**

Add re-exports for each new top-level directory under `packages/backend/src/`. Confirm each directory has an `index.ts` first; create them if missing (each is `export * from './<main-file>.js'`).

- [ ] **Step 6: Build + typecheck + test**

Run: `pnpm install && pnpm --filter @night-orch/backend build && pnpm typecheck && pnpm test`
Expected: all pass. Expect to chase a handful of broken import paths — `grep -rln "from '\.\./\.\./" packages/backend/src` and fix layer-relative paths that now point one level too high.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "[REFACTOR] Move remaining engine modules into @night-orch/backend"
```

### Task 2.6: Move `mcp/` + `web/` route handlers (server-side, NOT SPA)

**Files:**
- Move: `src/mcp/` → `packages/backend/src/mcp/`
- Move: `src/web/` (server, routes, auth, snapshots, agent-session) → `packages/backend/src/http/`

Naming: rename `web/` to `http/` inside backend to disambiguate from the SPA package.

- [ ] **Step 1: Move MCP**

```bash
git mv src/mcp packages/backend/src/mcp
[ -d test/mcp ] && git mv test/mcp packages/backend/test/mcp || true
```

- [ ] **Step 2: Move HTTP/web server**

```bash
git mv src/web packages/backend/src/http
[ -d test/web ] && git mv test/web packages/backend/test/http || true
```

- [ ] **Step 3: Fix internal references**

```bash
grep -rln "from '.*src/web/\|from '.*src/mcp/" src packages | xargs -r sed -i "s|src/web/|src/http/|g"
```

Verify by reading any failing typecheck.

- [ ] **Step 4: Update backend `index.ts`**

```typescript
export * from './http/index.js'
export * from './mcp/index.js'
```

(Add these to existing list. Provide `index.ts` in each if not present.)

- [ ] **Step 5: Build + typecheck + test**

Run: `pnpm --filter @night-orch/backend build && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "[REFACTOR] Move MCP + HTTP server (renamed from web/) into @night-orch/backend"
```

### Task 2.7: Move `supervisor/` to backend temporarily (will move to runner pkg in M3)

This makes M2 internally consistent (everything-not-cli lives in backend) before we carve out `runner`. M3 then moves it out.

- [ ] **Step 1: Move it**

```bash
git mv src/supervisor packages/backend/src/supervisor
[ -d test/supervisor ] && git mv test/supervisor packages/backend/test/supervisor || true
```

- [ ] **Step 2: Fix imports**

```bash
grep -rln "from '.*src/supervisor/\|from '\.\./supervisor/" src packages | head
```

Fix any reported paths.

- [ ] **Step 3: Update backend `index.ts`** to add `export * from './supervisor/index.js'`.

- [ ] **Step 4: Build + typecheck + test**

Run: `pnpm --filter @night-orch/backend build && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "[REFACTOR] Move supervisor into @night-orch/backend (temporary — will move to runner pkg in M3)"
```

### Task 2.8: Update CLI to import from `@night-orch/backend`

**Files:**
- Modify: `src/cli/**/*.ts` — replace internal relative imports with `@night-orch/backend` / `@night-orch/shared`

- [ ] **Step 1: Sweep CLI imports**

```bash
grep -rln "from '\.\./\(state\|forge\|loop\|workers\|poller\|discovery\|orchestration\|http\|mcp\|supervisor\|mentions\|reactions\|publishing\|labels\|notify\|metrics\|ops\|git\|environment\|merge-queue\|planning\|work-items\|fileloop\|events\|settings\|ai\|components\|utils\|config\)/" src/cli
```

For each match, replace the relative path with `@night-orch/backend` or `@night-orch/shared`. Use a sed sweep, but inspect a few results first to make sure it's correct.

- [ ] **Step 2: Delete the barrel files at old `src/*/` paths**

Now that CLI imports are clean, the barrels at `src/state/index.ts`, `src/forge/index.ts`, … should have zero remaining consumers.

```bash
grep -rln "from '\.\./\(state\|forge\|loop\|workers\)/index\.js'" src | head
```

Expected: empty. If empty, delete the barrels:

```bash
find src -maxdepth 2 -name index.ts -path "src/*/index.ts" -not -path "src/cli/*" -delete
```

Verify: typecheck still passes.

- [ ] **Step 3: Build + typecheck + lint + test**

Run: `pnpm --filter @night-orch/backend build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "[REFACTOR] Point CLI at @night-orch/backend, drop old barrel files"
```

### Task 2.9: M2 acceptance check

- [ ] **Step 1: Verify `src/` only contains CLI**

Run: `ls src/`
Expected: only `cli/` (and possibly `index.ts` if the bin entry sits here).

- [ ] **Step 2: Run full verification**

Run: `pnpm install && pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 3: Run `pnpm dev doctor` and `pnpm dev run-once`**

Run: `pnpm dev doctor`
Expected: exits 0.

`run-once` requires a live config; skip if no fixture available, else: `pnpm dev run-once --config examples/config.example.yaml` against a test fixture. Expected: completes one poll cycle without error.

- [ ] **Step 4: No new commit — M2 already committed task-by-task.**

---

# M3 — Extract `@night-orch/runner`

Goal: lift the supervisor out of `backend` into its own package, depending only on `@night-orch/shared`. Backend no longer exports supervisor.

### Task 3.1: Create `@night-orch/runner` skeleton

**Files:**
- Create: `packages/runner/package.json`
- Create: `packages/runner/tsconfig.json`
- Create: `packages/runner/src/index.ts`

- [ ] **Step 1: Write `packages/runner/package.json`**

```json
{
  "name": "@night-orch/runner",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@night-orch/shared": "workspace:*",
    "pino": "<pin to root version>"
  }
}
```

- [ ] **Step 2: Write `packages/runner/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "test"]
}
```

- [ ] **Step 3: Empty `packages/runner/src/index.ts`** with `export {}`.

- [ ] **Step 4: Add `runner` to root tsconfig references and to root `package.json` deps**

Add to root tsconfig references: `{ "path": "./packages/runner" }`.
Add to root deps: `"@night-orch/runner": "workspace:*"`.

- [ ] **Step 5: Install + build**

Run: `pnpm install && pnpm --filter @night-orch/runner build`
Expected: builds (empty).

- [ ] **Step 6: Commit**

```bash
git add packages/runner tsconfig.json package.json pnpm-lock.yaml
git commit -m "[REFACTOR] Create @night-orch/runner package skeleton"
```

### Task 3.2: Move supervisor code into `runner`

**Files:**
- Move: `packages/backend/src/supervisor/` → `packages/runner/src/`
- Tests: `packages/backend/test/supervisor/` → `packages/runner/test/`

- [ ] **Step 1: Move the tree**

```bash
git mv packages/backend/src/supervisor/* packages/runner/src/
rmdir packages/backend/src/supervisor
[ -d packages/backend/test/supervisor ] && git mv packages/backend/test/supervisor packages/runner/test || true
```

- [ ] **Step 2: Identify what the supervisor imports from backend**

```bash
grep -rn "from '@night-orch/backend\|from '\.\." packages/runner/src
```

Expected (per spec D1): runner depends only on `@night-orch/shared`. If it currently imports anything from backend (e.g. config loader), refactor:
- Move the imported function into `@night-orch/shared` if pure; OR
- Receive the value via constructor / fn argument so runner stays I/O-isolated.

For the config loader (`loadConfig` / `resolveConfigPath`), runner needs the resolved config. Strategy: runner calls `loadConfig` from `@night-orch/backend/config`, accept this one cross-package dep with a comment. Add `@night-orch/backend` to runner's deps in package.json as a runtime dep used only for config loading.

Update `packages/runner/package.json` dependencies:

```json
"dependencies": {
  "@night-orch/shared": "workspace:*",
  "@night-orch/backend": "workspace:*",
  "pino": "<copy exact version from root package.json>"
}
```

And add `{ "path": "../backend" }` to runner's `tsconfig.json` references.

- [ ] **Step 3: Update runner `src/index.ts`** to re-export supervisor entry point(s):

```typescript
export { Supervisor } from './index.js' // adjust to actual filename
```

(Inspect `packages/runner/src/` and replace with real exports.)

- [ ] **Step 4: Update `packages/backend/src/index.ts`** — remove the line that exported supervisor.

- [ ] **Step 5: Update CLI usage**

```bash
grep -rln "Supervisor\|supervisor" src/cli/
```

Replace any `import … from '@night-orch/backend'` for supervisor types with `import … from '@night-orch/runner'`.

- [ ] **Step 6: Build + typecheck + test**

Run: `pnpm install && pnpm --filter @night-orch/runner build && pnpm --filter @night-orch/backend build && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "[REFACTOR] Move supervisor from @night-orch/backend into @night-orch/runner"
```

### Task 3.3: Split supervisor file into 4 focused modules

Per file structure plan: target ≤ 250 LOC per file. Current `packages/runner/src/index.ts` (was `src/supervisor/index.ts`) is likely 400+ LOC. Split into `supervisor.ts`, `health-probe.ts`, `update-fsm.ts`, `ipc.ts`.

- [ ] **Step 1: Inspect current shape**

Run: `wc -l packages/runner/src/*.ts && head -60 packages/runner/src/index.ts`
Expected: identifies which functions/classes belong in which slice.

- [ ] **Step 2: Extract `health-probe.ts`**

Move the `probeHealthEndpoint` + `resolveSupervisorHealthTargets` + related helpers (currently in `health.ts`) into `health-probe.ts`. If they already live in `health.ts`, just rename:

```bash
git mv packages/runner/src/health.ts packages/runner/src/health-probe.ts
```

Update imports inside the package.

- [ ] **Step 3: Extract `update-fsm.ts`**

Move `runUpdate`, `rollbackToCheckpoint`, `UpdateStatusTracker`, `UpdateResult` (currently in `updater.ts`, `status.ts`, `update-control.ts`). Decide whether to combine all into `update-fsm.ts` or keep `update-fsm.ts` as the FSM logic only and leave persistence in `update-status.ts`:

```bash
git mv packages/runner/src/updater.ts packages/runner/src/update-fsm.ts
git mv packages/runner/src/status.ts packages/runner/src/update-status.ts
# update-control.ts probably stays as control wiring; leave it.
```

Update imports.

- [ ] **Step 4: Add `ipc.ts` (new file)**

Currently fork-IPC uses inline `process.send` / `'message'` listeners. Extract to a typed helper.

Write `packages/runner/src/ipc.ts`:

```typescript
import type { ChildProcess } from 'node:child_process'

export type RunnerCommand =
  | { type: 'drain'; correlationId: string }
  | { type: 'stop'; correlationId: string }
  | { type: 'set-maintenance'; value: boolean; correlationId: string }
  | { type: 'reload-config'; correlationId: string }

export type RunnerEvent =
  | { type: 'ack'; correlationId: string }
  | { type: 'error'; correlationId: string; message: string }
  | { type: 'child-up'; name: string; pid: number }
  | { type: 'child-down'; name: string; pid: number; exitCode: number | null; signal: NodeJS.Signals | null }

export function sendCommand(child: ChildProcess, cmd: RunnerCommand, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage)
      reject(new Error(`IPC command ${cmd.type} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const onMessage = (raw: unknown): void => {
      const ev = raw as RunnerEvent
      if (ev?.type === 'ack' && ev.correlationId === cmd.correlationId) {
        clearTimeout(timer)
        child.off('message', onMessage)
        resolve()
      } else if (ev?.type === 'error' && ev.correlationId === cmd.correlationId) {
        clearTimeout(timer)
        child.off('message', onMessage)
        reject(new Error(ev.message))
      }
    }

    child.on('message', onMessage)
    const sent = child.send(cmd)
    if (!sent) {
      clearTimeout(timer)
      child.off('message', onMessage)
      reject(new Error('child.send returned false — IPC channel not writable'))
    }
  })
}
```

Wire any existing supervisor-side fork IPC through `sendCommand` instead of raw `child.send`.

- [ ] **Step 5: Trim `supervisor.ts` (rename of `index.ts`)**

```bash
git mv packages/runner/src/index.ts packages/runner/src/supervisor.ts
```

Recreate `packages/runner/src/index.ts`:

```typescript
export { Supervisor } from './supervisor.js'
export type { RunnerCommand, RunnerEvent } from './ipc.js'
export { probeHealthEndpoint } from './health-probe.js'
```

- [ ] **Step 6: Verify `wc -l` per file ≤ 250**

Run: `wc -l packages/runner/src/*.ts`
Expected: every file ≤ 250 LOC. If one is over, split further.

- [ ] **Step 7: Build + typecheck + test**

Run: `pnpm --filter @night-orch/runner build && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/runner
git commit -m "[REFACTOR] Split runner into supervisor / health-probe / update-fsm / ipc"
```

### Task 3.4: M3 acceptance check

- [ ] **Step 1: Run full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 2: Confirm runner LOC budget**

Run: `wc -l packages/runner/src/*.ts | tail -1`
Expected: total ≤ 800.

- [ ] **Step 3: Run `pnpm dev doctor`**

Expected: exits 0.

- [ ] **Step 4: No new commit — M3 already committed.**

---

# M4 — Extract `@night-orch/web`

Goal: move SPA bundle and its build pipeline into `packages/web/`. SPA behavior unchanged.

### Task 4.1: Create `@night-orch/web` skeleton

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`

- [ ] **Step 1: Write `packages/web/package.json`**

```json
{
  "name": "@night-orch/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@night-orch/shared": "workspace:*"
  }
}
```

Copy SPA runtime deps (react, react-dom, react-router, etc.) from current `web/package.json` (or, if SPA deps live in root, copy them here).

- [ ] **Step 2: Skeleton `packages/web/tsconfig.json`** — temporary, will be overwritten when we move `web/tsconfig.json`.

- [ ] **Step 3: Commit**

```bash
git add packages/web tsconfig.json package.json
git commit -m "[REFACTOR] Create @night-orch/web package skeleton"
```

### Task 4.2: Move `web/` tree into `packages/web/`

**Files:**
- Move: top-level `web/src/` → `packages/web/src/spa/`
- Move: `web/vite.config.ts` → `packages/web/vite.config.ts`
- Move: `web/tsconfig.json` → `packages/web/tsconfig.json`
- Move: `web/index.html` → `packages/web/index.html`

- [ ] **Step 1: Move**

```bash
mkdir -p packages/web/src
git mv web/src packages/web/src/spa
git mv web/vite.config.ts packages/web/vite.config.ts
git mv web/tsconfig.json packages/web/tsconfig.json
git mv web/index.html packages/web/index.html
rmdir web 2>/dev/null || ls web  # confirm empty
```

- [ ] **Step 2: Update `packages/web/vite.config.ts`**

Adjust `root` / `build.outDir` to be relative to `packages/web/`. Verify it still resolves `index.html`.

- [ ] **Step 3: Update root `package.json` scripts**

Replace `web:dev` / `web:build` / `web:typecheck` to invoke via pnpm filter:

```json
"web:dev": "pnpm --filter @night-orch/web dev",
"web:build": "pnpm --filter @night-orch/web build",
"web:typecheck": "pnpm --filter @night-orch/web typecheck"
```

- [ ] **Step 4: Update `prepack` / `install-global`** in root `package.json` to point at the new path (or invoke `pnpm --filter @night-orch/web build`).

- [ ] **Step 5: Run web build**

Run: `pnpm web:build`
Expected: produces `packages/web/dist/` (or whatever `outDir` resolves to). Confirm assets generated.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "[REFACTOR] Move SPA into @night-orch/web/src/spa"
```

### Task 4.3: Update backend HTTP server to find SPA bundle in new location

**Files:**
- Modify: any backend code that serves SPA static assets (look in `packages/backend/src/http/`)

- [ ] **Step 1: Find SPA path references**

```bash
grep -rln "'web/dist'\|web/dist'" packages/backend/src
```

- [ ] **Step 2: Replace path resolution**

Replace `web/dist` references with a function that resolves the SPA build relative to the workspace root:

```typescript
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export function resolveSpaDir(): string {
  // Going from packages/backend/dist/<file> → packages/web/dist
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../../../web/dist')
}
```

Or, simpler: read the path from config (already supported in `src/config/schema.ts`) and update the example config + docs.

- [ ] **Step 3: Build + run web test**

Run: `pnpm web:build && pnpm dev demo --port 3251`
Expected: SPA serves at `http://127.0.0.1:3251`.

Kill the dev server (Ctrl+C) when verified.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "[REFACTOR] Resolve SPA bundle from @night-orch/web/dist"
```

### Task 4.4: Update `docs/CONFIGURATION.md` if SPA path config changed

Per project rule `07-config-doc-sync.md`: any user-visible config change must update `docs/CONFIGURATION.md`.

- [ ] **Step 1: Inspect**

Read `docs/CONFIGURATION.md` for any `web.spaDir` / `web.assets` field. Update path examples if they referenced `web/dist`.

- [ ] **Step 2: Commit if changed**

```bash
git add docs/CONFIGURATION.md
git commit -m "[DOCS] Point SPA path examples at packages/web/dist"
```

### Task 4.5: M4 acceptance check

- [ ] **Step 1: Run full verification**

Run: `pnpm install && pnpm web:build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 2: Smoke-test SPA**

Run: `pnpm dev demo --port 3251` (or equivalent), open `http://127.0.0.1:3251` in browser, verify SPA loads.

- [ ] **Step 3: No new commit — M4 already committed.**

---

# M5 — Web becomes reverse-proxy + runner forks separate processes

This is the real architectural flip. Backend opens its own loopback HTTP port; web binds the public port and proxies. Runner spawns them as separate Node processes.

### Task 5.1: Add `bin.ts` to `@night-orch/web`

**Files:**
- Create: `packages/web/src/bin.ts`
- Create: `packages/web/src/proxy.ts`
- Create: `packages/web/src/static.ts`

- [ ] **Step 1: Write the failing test for proxy header forwarding**

`packages/web/test/proxy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createProxy } from '../src/proxy.js'

interface CapturedRequest { headers: NodeJS.Dict<string | string[]>; method?: string; url?: string; body: string }

async function startBackend(): Promise<{ server: Server; port: number; captured: CapturedRequest[] }> {
  const captured: CapturedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      captured.push({ headers: req.headers, method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  if (typeof addr !== 'object' || !addr) throw new Error('no addr')
  return { server, port: addr.port, captured }
}

describe('createProxy', () => {
  it('forwards Authorization header and request body', async () => {
    const backend = await startBackend()
    const proxy = createProxy({ targetHost: '127.0.0.1', targetPort: backend.port })
    const server = createServer(proxy)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const addr = server.address()
    if (typeof addr !== 'object' || !addr) throw new Error('no addr')

    const res = await fetch(`http://127.0.0.1:${addr.port}/api/runs`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(res.status).toBe(200)
    const capture = backend.captured[0]
    expect(capture).toBeDefined()
    expect(capture!.headers.authorization).toBe('Bearer test-token')
    expect(capture!.body).toBe('{"hello":"world"}')
    expect(capture!.url).toBe('/api/runs')

    server.close()
    backend.server.close()
  })
})
```

Run: `pnpm --filter @night-orch/web test`
Expected: FAILS — `createProxy` not defined.

- [ ] **Step 2: Implement `packages/web/src/proxy.ts`**

```typescript
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'

export interface ProxyOptions {
  targetHost: string
  targetPort: number
}

export function createProxy(opts: ProxyOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const upstream = httpRequest(
      {
        host: opts.targetHost,
        port: opts.targetPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 'E_PROXY_UPSTREAM', message: err.message }))
    })
    req.pipe(upstream)
  }
}
```

- [ ] **Step 3: Run test**

Run: `pnpm --filter @night-orch/web test`
Expected: PASS.

- [ ] **Step 4: Write SSE-framing test**

Append to `packages/web/test/proxy.test.ts`:

```typescript
it('preserves SSE framing and streams chunks', async () => {
  const captured: string[] = []
  const backend = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('data: hello\n\n')
    setTimeout(() => res.write('data: world\n\n'), 20)
    setTimeout(() => res.end(), 40)
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const backendAddr = backend.address()
  if (typeof backendAddr !== 'object' || !backendAddr) throw new Error('no addr')

  const proxy = createProxy({ targetHost: '127.0.0.1', targetPort: backendAddr.port })
  const proxyServer = createServer(proxy)
  proxyServer.listen(0, '127.0.0.1')
  await once(proxyServer, 'listening')
  const proxyAddr = proxyServer.address()
  if (typeof proxyAddr !== 'object' || !proxyAddr) throw new Error('no addr')

  const res = await fetch(`http://127.0.0.1:${proxyAddr.port}/api/events`)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    captured.push(decoder.decode(value))
  }
  expect(captured.join('')).toContain('data: hello')
  expect(captured.join('')).toContain('data: world')

  proxyServer.close()
  backend.close()
})
```

Add `import { createServer } from 'node:http'` if not already present.

- [ ] **Step 5: Run test**

Run: `pnpm --filter @night-orch/web test`
Expected: PASS (the simple proxy already streams chunks through `.pipe`).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/proxy.ts packages/web/test/proxy.test.ts
git commit -m "[FEATURE] Reverse-proxy module with header + SSE forwarding for @night-orch/web"
```

### Task 5.2: Implement web `static.ts`

**Files:**
- Create: `packages/web/src/static.ts`

- [ ] **Step 1: Write the failing test**

`packages/web/test/static.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createStaticHandler } from '../src/static.js'

let dir: string
let server: Server
let port: number

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'web-static-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")', 'utf8')
  server = createServer(createStaticHandler({ rootDir: dir }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  if (typeof addr !== 'object' || !addr) throw new Error('no addr')
  port = addr.port
})

afterAll(() => { server.close() })

describe('createStaticHandler', () => {
  it('serves the SPA index on /', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>spa</title>')
  })

  it('serves nested assets', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })

  it('SPA-fallbacks unknown routes to index.html', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/runs/abc/detail`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>spa</title>')
  })
})
```

Run: `pnpm --filter @night-orch/web test`
Expected: FAILS — `createStaticHandler` not defined.

- [ ] **Step 2: Implement `packages/web/src/static.ts`**

```typescript
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export interface StaticHandlerOptions {
  rootDir: string
}

export function createStaticHandler(opts: StaticHandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(opts.rootDir)

  return (req, res) => {
    const url = req.url ?? '/'
    const pathname = url.split('?')[0] ?? '/'
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
    let filePath = join(root, safe === '/' ? 'index.html' : safe)

    if (!filePath.startsWith(root)) {
      res.statusCode = 403
      res.end('Forbidden')
      return
    }

    try {
      const stat = statSync(filePath)
      if (stat.isDirectory()) {
        filePath = join(filePath, 'index.html')
      }
      statSync(filePath)
    } catch {
      // SPA fallback
      filePath = join(root, 'index.html')
    }

    const ext = extname(filePath).toLowerCase()
    res.setHeader('content-type', MIME_TYPES[ext] ?? 'application/octet-stream')
    createReadStream(filePath).pipe(res)
  }
}
```

- [ ] **Step 3: Run test**

Run: `pnpm --filter @night-orch/web test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/static.ts packages/web/test/static.test.ts
git commit -m "[FEATURE] Static asset handler with SPA fallback for @night-orch/web"
```

### Task 5.3: Wire `bin.ts` — web server that combines proxy + static

**Files:**
- Create: `packages/web/src/bin.ts`

- [ ] **Step 1: Write failing E2E test**

`packages/web/test/bin.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWebServer } from '../src/bin.js'

let backend: Server
let backendPort: number
let dir: string
let stopWeb: () => Promise<void>
let webPort: number

beforeAll(async () => {
  backend = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ via: 'backend', path: req.url }))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const addr = backend.address()
  if (typeof addr !== 'object' || !addr) throw new Error('no addr')
  backendPort = addr.port

  dir = mkdtempSync(join(tmpdir(), 'web-bin-'))
  writeFileSync(join(dir, 'index.html'), '<title>spa</title>')

  const handle = await startWebServer({
    host: '127.0.0.1',
    port: 0,
    spaDir: dir,
    backendUrl: `http://127.0.0.1:${backendPort}`,
  })
  stopWeb = handle.stop
  webPort = handle.port
})

afterAll(async () => {
  await stopWeb()
  backend.close()
})

describe('startWebServer', () => {
  it('proxies /api/* to backend', async () => {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/runs`)
    expect(res.status).toBe(200)
    const body = await res.json() as { via: string; path: string }
    expect(body.via).toBe('backend')
    expect(body.path).toBe('/api/runs')
  })

  it('serves SPA for /', async () => {
    const res = await fetch(`http://127.0.0.1:${webPort}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>spa</title>')
  })

  it('serves SPA fallback for client routes', async () => {
    const res = await fetch(`http://127.0.0.1:${webPort}/runs/abc`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>spa</title>')
  })
})
```

Run: `pnpm --filter @night-orch/web test`
Expected: FAILS — `startWebServer` not defined.

- [ ] **Step 2: Implement `packages/web/src/bin.ts`**

```typescript
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createProxy } from './proxy.js'
import { createStaticHandler } from './static.js'

export interface StartWebServerOptions {
  host: string
  port: number
  spaDir: string
  backendUrl: string
}

export interface WebServerHandle {
  port: number
  stop: () => Promise<void>
}

export async function startWebServer(opts: StartWebServerOptions): Promise<WebServerHandle> {
  const backendUrl = new URL(opts.backendUrl)
  const proxy = createProxy({
    targetHost: backendUrl.hostname,
    targetPort: Number(backendUrl.port),
  })
  const staticHandler = createStaticHandler({ rootDir: opts.spaDir })

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/api/')) {
      proxy(req, res)
      return
    }
    staticHandler(req, res)
  })

  server.listen(opts.port, opts.host)
  await once(server, 'listening')
  const addr = server.address()
  if (typeof addr !== 'object' || !addr) throw new Error('web server did not bind')

  return {
    port: addr.port,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.WEB_HOST ?? '127.0.0.1'
  const port = Number(process.env.WEB_PORT ?? '3200')
  const spaDir = process.env.WEB_SPA_DIR ?? new URL('../dist', import.meta.url).pathname
  const backendUrl = process.env.WEB_BACKEND_URL ?? 'http://127.0.0.1:3201'
  void startWebServer({ host, port, spaDir, backendUrl }).then((h) => {
    process.stdout.write(`web listening on http://${host}:${h.port}, proxying /api/* → ${backendUrl}\n`)
  })
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @night-orch/web test`
Expected: all pass.

- [ ] **Step 4: Add `bin` entry to `packages/web/package.json`**

```json
"bin": {
  "night-orch-web": "./dist/bin.js"
},
"main": "./dist/bin.js"
```

- [ ] **Step 5: Build**

Run: `pnpm --filter @night-orch/web build`
Expected: `packages/web/dist/bin.js` exists. (Build pipeline must include TS compile in addition to vite SPA build — add a `tsc` step.)

Update `packages/web/package.json` scripts:

```json
"build": "tsc -p tsconfig.server.json && vite build"
```

Create `packages/web/tsconfig.server.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src/bin.ts", "src/proxy.ts", "src/static.ts"],
  "exclude": ["src/spa"]
}
```

Re-run build, confirm `dist/bin.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/web
git commit -m "[FEATURE] Web bin combining reverse-proxy and SPA static server"
```

### Task 5.4: Backend opens its own loopback HTTP port + writes port file

**Files:**
- Modify: `packages/backend/src/http/server.ts` (or equivalent — find the HTTP entry)
- Modify: `packages/backend/src/index.ts` to start backend as standalone process

- [ ] **Step 1: Find backend HTTP entry**

Run: `grep -rln "createServer\|listen(" packages/backend/src/http`
Expected: finds the server bootstrap.

- [ ] **Step 2: Write failing test for port-file**

`packages/backend/test/http/port-file.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBackendHttp } from '../../src/http/bin.js'

let dir: string
let stop: () => Promise<void>

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'backend-port-')) })
afterEach(async () => { await stop?.(); rmSync(dir, { recursive: true, force: true }) })

describe('startBackendHttp', () => {
  it('writes the bound port to <dataDir>/backend.port', async () => {
    const handle = await startBackendHttp({ host: '127.0.0.1', port: 0, dataDir: dir })
    stop = handle.stop
    const written = readFileSync(join(dir, 'backend.port'), 'utf8').trim()
    expect(Number(written)).toBe(handle.port)
    expect(handle.port).toBeGreaterThan(0)
  })
})
```

Run: `pnpm --filter @night-orch/backend test`
Expected: FAILS — `startBackendHttp` not defined or doesn't write port file.

- [ ] **Step 3: Implement `packages/backend/src/http/bin.ts`**

```typescript
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequestHandler } from './handler.js' // existing route handler factory

export interface BackendHttpOptions {
  host: string
  port: number
  dataDir: string
}

export interface BackendHttpHandle {
  port: number
  stop: () => Promise<void>
}

export async function startBackendHttp(opts: BackendHttpOptions): Promise<BackendHttpHandle> {
  const handler = createRequestHandler() // wires existing routes
  const server = createServer(handler)
  server.listen(opts.port, opts.host)
  await once(server, 'listening')
  const addr = server.address()
  if (typeof addr !== 'object' || !addr) throw new Error('backend HTTP did not bind')
  writeFileSync(join(opts.dataDir, 'backend.port'), String(addr.port), { mode: 0o600 })

  return {
    port: addr.port,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
```

If `createRequestHandler` does not exist, extract one from the existing server file (today it's likely an inline composition). The smallest extraction: a function that returns the same `(req, res) =>` handler the current server.ts attaches.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @night-orch/backend test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/http packages/backend/test/http
git commit -m "[FEATURE] Backend HTTP writes bound port to <dataDir>/backend.port"
```

### Task 5.5: Runner forks backend + web as separate child processes

**Files:**
- Modify: `packages/runner/src/supervisor.ts`

- [ ] **Step 1: Locate current child definitions**

Run: `grep -n "name: 'run'\|name: 'web'" packages/runner/src/supervisor.ts`
Expected: finds the two existing entries.

- [ ] **Step 2: Replace child topology**

Replace the `this.children = […]` block in `Supervisor.start()` with:

```typescript
this.children = [
  {
    name: 'backend',
    args: [...this.options.globalArgs, 'serve-backend'],
    process: null,
    status: 'stopped',
    restartCount: 0,
    lastStartedAt: 0,
    pendingRespawn: null,
  },
  ...(this.options.webEnabled ? [{
    name: 'web',
    args: [...this.options.globalArgs, 'serve-web', ...this.options.webArgs],
    process: null,
    status: 'stopped' as const,
    restartCount: 0,
    lastStartedAt: 0,
    pendingRespawn: null,
  }] : []),
]
```

Add `webEnabled: boolean` to `SupervisorOptions`.

- [ ] **Step 3: Pass `backendUrl` to web on startup**

Once backend has reported its port (via `backend.port` file or fork-IPC `child-up` event), the supervisor sends a fork-IPC message to web with `backendUrl`. Web's `bin.ts` listens for `process.on('message', …)` and uses the URL.

Add to `packages/web/src/bin.ts` after the `startWebServer` import-meta-url launch block:

```typescript
process.on('message', (msg: unknown) => {
  const m = msg as { type: string; backendUrl?: string }
  if (m?.type === 'config' && m.backendUrl) {
    process.env.WEB_BACKEND_URL = m.backendUrl
  }
})
```

In the supervisor, after spawning the web child:

```typescript
// Wait for backend port file to exist (poll up to 30s)
const backendPort = await waitForBackendPort(this.options.dataDir, 30_000)
const backendUrl = `http://127.0.0.1:${backendPort}`
webChild.send({ type: 'config', backendUrl })
```

Implement `waitForBackendPort` in `packages/runner/src/health-probe.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export async function waitForBackendPort(dataDir: string, timeoutMs: number): Promise<number> {
  const file = join(dataDir, 'backend.port')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8').trim()
      const port = Number(raw)
      if (Number.isFinite(port) && port > 0) return port
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`backend.port not found in ${dataDir} within ${timeoutMs}ms`)
}
```

- [ ] **Step 4: Add `serve-backend` + `serve-web` CLI subcommands**

In `src/cli/index.ts` (or wherever commander is wired):

```typescript
program
  .command('serve-backend')
  .description('Start the backend HTTP + engine process (internal — invoked by runner)')
  .action(async () => {
    const { startBackend } = await import('@night-orch/backend')
    await startBackend()
  })

program
  .command('serve-web')
  .description('Start the web reverse-proxy + static server (internal — invoked by runner)')
  .action(async () => {
    const { startWebServer } = await import('@night-orch/web')
    const dataDir = process.env.NIGHT_ORCH_DATA_DIR ?? '.'
    const backendUrl = process.env.WEB_BACKEND_URL ?? `http://127.0.0.1:3201`
    await startWebServer({
      host: process.env.WEB_HOST ?? '127.0.0.1',
      port: Number(process.env.WEB_PORT ?? '3200'),
      spaDir: process.env.WEB_SPA_DIR ?? new URL('../../web/dist', import.meta.url).pathname,
      backendUrl,
    })
  })
```

`startBackend()` should be added to backend's `index.ts` — it starts the HTTP server (via `startBackendHttp`) plus the engine + poller. Wrap whatever the current `night-orch run` command does.

- [ ] **Step 5: Run E2E test**

`packages/runner/test/supervisor-spawn.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../src/supervisor.js'

describe('Supervisor.start (M5 topology)', () => {
  it('spawns backend and web children using serve-backend and serve-web args', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sup-'))
    const sup = new Supervisor({
      projectRoot: process.cwd(),
      globalArgs: ['--data-dir', dataDir],
      webArgs: ['--port', '0'],
      dataDir,
      webEnabled: true,
    })
    await sup.start()
    expect(sup.childNames()).toEqual(['backend', 'web'])
    await sup.shutdown()
    rmSync(dataDir, { recursive: true, force: true })
  })
})
```

(Add `childNames()` and `shutdown()` helpers on Supervisor if not present.)

Run: `pnpm --filter @night-orch/runner test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "[FEATURE] Runner forks backend + web as separate processes with backendUrl handoff"
```

### Task 5.6: Smoke-test the live system

- [ ] **Step 1: Launch via mise dev script**

Run: `pnpm web:build && pnpm dev` (or whatever the equivalent of `mise run dev-solo` is in the new layout).
Expected:
- Runner starts, logs `child-up name=backend pid=<n>` then `child-up name=web pid=<n>`.
- `<dataDir>/backend.port` file exists.
- `curl http://127.0.0.1:3200/` returns SPA HTML.
- `curl http://127.0.0.1:3200/api/health` returns backend health JSON.

- [ ] **Step 2: Kill backend, verify recovery**

In a second shell: `pkill -f 'serve-backend'`
Expected:
- Runner log shows `child-down name=backend exit=…` then within ~1s `child-up name=backend`.
- After ~3s, the port file is updated to the new port and `curl http://127.0.0.1:3200/api/health` returns 200 again.

- [ ] **Step 3: Kill web, verify backend unaffected**

`pkill -f 'serve-web'`
Expected:
- Runner respawns web within ~1s.
- During the gap, `curl http://127.0.0.1:3200/api/health` returns connection refused, but if you `curl http://127.0.0.1:<backend.port>/api/health` directly it returns 200.

- [ ] **Step 4: No commit — verification only.**

### Task 5.7: Update docs

Per project rules `07-config-doc-sync.md`: process topology change is user-visible.

- [ ] **Step 1: Update `docs/OVERVIEW.md`**

Replace any single-process diagrams with the M5 process diagram from the spec. Add a "Process model" section.

- [ ] **Step 2: Update `docs/USAGE.md`**

Document the new `serve-backend` / `serve-web` internal subcommands (note they are not for direct use).

- [ ] **Step 3: Update `docs/CONFIGURATION.md`**

Document new env vars (`WEB_HOST`, `WEB_PORT`, `WEB_SPA_DIR`) and config fields (`web.enabled`).

- [ ] **Step 4: Build docs**

Run: `pnpm docs:build`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "[DOCS] Document new runner/backend/web process topology"
```

### Task 5.8: M5 acceptance check

- [ ] **Step 1: Full verification**

Run: `pnpm install && pnpm web:build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 2: Run smoke tests from 5.6 again to confirm no regression.**

- [ ] **Step 3: No new commit — M5 already committed.**

---

# M6 — Formalize `@night-orch/shared` as IPC contract source

Goal: every cross-process payload type lives only in `shared`. No duplicate type defs elsewhere.

### Task 6.1: Define IPC envelopes in `shared/src/schemas/ipc.ts`

**Files:**
- Create: `packages/shared/src/schemas/ipc.ts`

- [ ] **Step 1: Write failing test**

`packages/shared/test/schemas/ipc.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ApiResponseSchema, ApiErrorSchema, SseEventSchema } from '../../src/schemas/ipc.js'

describe('ApiResponse schema', () => {
  it('accepts {data}', () => {
    const parsed = ApiResponseSchema.safeParse({ data: { id: 'r1' } })
    expect(parsed.success).toBe(true)
  })
  it('rejects extra top-level keys', () => {
    const parsed = ApiResponseSchema.safeParse({ data: {}, extra: 1 })
    expect(parsed.success).toBe(false)
  })
})

describe('ApiError schema', () => {
  it('accepts {code, message}', () => {
    const parsed = ApiErrorSchema.safeParse({ code: 'E_NOT_FOUND', message: 'run missing' })
    expect(parsed.success).toBe(true)
  })
})

describe('SseEvent schema', () => {
  it('accepts known event types', () => {
    const parsed = SseEventSchema.safeParse({ type: 'run.started', data: { runId: 'x' } })
    expect(parsed.success).toBe(true)
  })
  it('rejects unknown event types', () => {
    const parsed = SseEventSchema.safeParse({ type: 'random.thing', data: {} })
    expect(parsed.success).toBe(false)
  })
})
```

Run: `pnpm --filter @night-orch/shared test`
Expected: FAILS.

- [ ] **Step 2: Implement `packages/shared/src/schemas/ipc.ts`**

```typescript
import { z } from 'zod'
import { ERROR_CODES, SSE_EVENT_NAMES } from '../constants/index.js'

export const ApiResponseSchema = z.object({ data: z.unknown() }).strict()
export type ApiResponse<T> = { data: T }

export const ApiErrorSchema = z.object({
  code: z.enum(Object.values(ERROR_CODES) as [string, ...string[]]),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
}).strict()
export type ApiError = z.infer<typeof ApiErrorSchema>

const sseTypes = SSE_EVENT_NAMES as readonly string[]
export const SseEventSchema = z.object({
  type: z.enum(sseTypes as [string, ...string[]]),
  data: z.unknown(),
}).strict()
export type SseEvent<T> = { type: typeof SSE_EVENT_NAMES[number]; data: T }
```

- [ ] **Step 3: Re-export from `packages/shared/src/schemas/index.ts`**

```typescript
export * from './config.js'
export * from './ipc.js'
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @night-orch/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "[FEATURE] IPC envelope schemas (ApiResponse, ApiError, SseEvent) in @night-orch/shared"
```

### Task 6.2: Define health schema in `shared/src/schemas/health.ts`

- [ ] **Step 1: Write failing test**

`packages/shared/test/schemas/health.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { HealthStatusSchema } from '../../src/schemas/health.js'

describe('HealthStatus schema', () => {
  it('accepts a valid backend health payload', () => {
    const ok = HealthStatusSchema.safeParse({
      status: 'ok',
      version: '0.20.0',
      process: 'backend',
      uptime_seconds: 12,
      maintenance: false,
      details: { db: 'ok', queueDepth: 0, activeRuns: 0 },
    })
    expect(ok.success).toBe(true)
  })
  it('rejects unknown status', () => {
    const bad = HealthStatusSchema.safeParse({ status: 'weird', version: '1', process: 'web', uptime_seconds: 1, maintenance: false })
    expect(bad.success).toBe(false)
  })
})
```

Run: expect FAIL.

- [ ] **Step 2: Implement**

`packages/shared/src/schemas/health.ts`:

```typescript
import { z } from 'zod'
import { PROCESS_NAMES } from '../constants/index.js'

export const HealthStatusSchema = z.object({
  status: z.enum(['ok', 'degraded', 'draining', 'down']),
  version: z.string(),
  process: z.enum(PROCESS_NAMES as unknown as [string, ...string[]]),
  uptime_seconds: z.number().nonnegative(),
  maintenance: z.boolean(),
  details: z.record(z.unknown()).optional(),
})
export type HealthStatus = z.infer<typeof HealthStatusSchema>
```

Add to `packages/shared/src/schemas/index.ts`:

```typescript
export * from './health.js'
```

- [ ] **Step 3: Test PASS**

- [ ] **Step 4: Commit**

```bash
git add packages/shared
git commit -m "[FEATURE] Health status schema in @night-orch/shared"
```

### Task 6.3: Define runner control message schemas

- [ ] **Step 1: Write failing test**

`packages/shared/test/schemas/runner-control.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { RunnerCommandSchema, RunnerEventSchema } from '../../src/schemas/runner-control.js'

describe('RunnerCommand', () => {
  it.each([
    { type: 'drain', correlationId: 'c1' },
    { type: 'stop', correlationId: 'c1' },
    { type: 'set-maintenance', value: true, correlationId: 'c1' },
    { type: 'reload-config', correlationId: 'c1' },
  ])('accepts %p', (cmd) => {
    expect(RunnerCommandSchema.safeParse(cmd).success).toBe(true)
  })
})

describe('RunnerEvent', () => {
  it('accepts ack', () => {
    expect(RunnerEventSchema.safeParse({ type: 'ack', correlationId: 'c1' }).success).toBe(true)
  })
  it('accepts child-up', () => {
    expect(RunnerEventSchema.safeParse({ type: 'child-up', name: 'backend', pid: 1 }).success).toBe(true)
  })
})
```

Run: expect FAIL.

- [ ] **Step 2: Implement**

`packages/shared/src/schemas/runner-control.ts`:

```typescript
import { z } from 'zod'

export const RunnerCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('drain'), correlationId: z.string() }),
  z.object({ type: z.literal('stop'), correlationId: z.string() }),
  z.object({ type: z.literal('set-maintenance'), value: z.boolean(), correlationId: z.string() }),
  z.object({ type: z.literal('reload-config'), correlationId: z.string() }),
])
export type RunnerCommand = z.infer<typeof RunnerCommandSchema>

export const RunnerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ack'), correlationId: z.string() }),
  z.object({ type: z.literal('error'), correlationId: z.string(), message: z.string() }),
  z.object({ type: z.literal('child-up'), name: z.string(), pid: z.number() }),
  z.object({ type: z.literal('child-down'), name: z.string(), pid: z.number(), exitCode: z.number().nullable(), signal: z.string().nullable() }),
])
export type RunnerEvent = z.infer<typeof RunnerEventSchema>
```

Re-export from `packages/shared/src/schemas/index.ts`.

- [ ] **Step 3: Test PASS, commit**

```bash
git add packages/shared
git commit -m "[FEATURE] Runner control message schemas in @night-orch/shared"
```

### Task 6.4: Migrate backend routes to import schemas from shared

- [ ] **Step 1: Find duplicate schema definitions**

Run: `grep -rln "z.object\|z.discriminatedUnion" packages/backend/src/http/`
Expected: list of files defining response/event shapes inline.

- [ ] **Step 2: For each duplicate, replace local schema with `import { … } from '@night-orch/shared'`**

For each file, look at the local schema, find or add a shared counterpart, then replace. Be careful: if shapes differ, the shared schema is the source of truth — adjust the route handler to produce the shared shape, not the other way around.

- [ ] **Step 3: Run test**

Run: `pnpm --filter @night-orch/backend test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/http
git commit -m "[REFACTOR] Backend routes consume schemas from @night-orch/shared"
```

### Task 6.5: Migrate runner's IPC envelope to consume shared schemas

In `packages/runner/src/ipc.ts`, replace the inline `RunnerCommand` / `RunnerEvent` types with imports from `@night-orch/shared`:

```typescript
import { RunnerCommandSchema, RunnerEventSchema, type RunnerCommand, type RunnerEvent } from '@night-orch/shared'
```

And add a runtime parse on receive:

```typescript
const onMessage = (raw: unknown): void => {
  const parsed = RunnerEventSchema.safeParse(raw)
  if (!parsed.success) return  // ignore garbage
  const ev = parsed.data
  // …existing logic
}
```

Same on the child side — validate incoming `RunnerCommand`.

- [ ] **Step 1: Make changes per above.**

- [ ] **Step 2: Test**

Run: `pnpm --filter @night-orch/runner test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/runner/src/ipc.ts
git commit -m "[REFACTOR] Runner IPC validates via @night-orch/shared schemas"
```

### Task 6.6: Add cross-package lint rule + remove dupes

- [ ] **Step 1: Add ESLint rule banning inline IPC types in backend/web/runner/cli**

Append to `eslint.config.js`:

```javascript
{
  files: ['packages/backend/src/http/**/*.ts', 'packages/runner/src/**/*.ts', 'packages/web/src/**/*.ts', 'src/cli/**/*.ts'],
  rules: {
    'no-restricted-syntax': ['warn', {
      selector: "TSInterfaceDeclaration[id.name=/^(Run|Issue|ApiResponse|ApiError|SseEvent|HealthStatus|RunnerCommand|RunnerEvent)$/]",
      message: 'Cross-process types must live in @night-orch/shared; import from there.',
    }],
  },
},
```

(Set to `'warn'` not `'error'` to avoid blocking edits that haven't migrated yet; flip to `'error'` once clean.)

- [ ] **Step 2: Run lint, fix any warnings**

Run: `pnpm lint`
For each warning, replace the inline type with a `import type { … } from '@night-orch/shared'`.

- [ ] **Step 3: Flip rule to `'error'`** once `pnpm lint` is clean.

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "[REFACTOR] Enforce single source of truth for cross-process types via @night-orch/shared"
```

---

# M7 — TUI extraction + HTTP rewire

Goal: move TUI into `packages/cli/src/tui/`, replace in-process imports with HTTP client calls to backend.

### Task 7.1: Create `@night-orch/cli` (extract from `src/`)

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Move: `src/cli/` → `packages/cli/src/`

- [ ] **Step 1: Write `packages/cli/package.json`**

```json
{
  "name": "night-orch",
  "version": "0.19.0",
  "private": false,
  "type": "module",
  "bin": {
    "night-orch": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@night-orch/shared": "workspace:*",
    "@night-orch/backend": "workspace:*",
    "@night-orch/runner": "workspace:*",
    "@night-orch/web": "workspace:*",
    "commander": "<copy exact version from root package.json>",
    "ink": "<copy exact version from root package.json>",
    "react": "<copy exact version from root package.json>"
  }
}
```

(Move version from root `package.json` once cli is the published bin. Root `package.json` may keep version for tooling but the published artifact is `packages/cli`.)

- [ ] **Step 2: `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx"
  },
  "references": [
    { "path": "../shared" },
    { "path": "../backend" },
    { "path": "../runner" }
  ],
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 3: Move CLI source**

```bash
git mv src/cli/* packages/cli/src/
rmdir src/cli
[ -d test/cli ] && git mv test/cli packages/cli/test || true
```

- [ ] **Step 4: Update root `package.json`** — remove its `bin` field, change `scripts.build` to delegate to workspace:

```json
"build": "pnpm -r build",
"typecheck": "pnpm -r typecheck",
"test": "pnpm -r test"
```

- [ ] **Step 5: Add cli to root tsconfig references + deps**

- [ ] **Step 6: Install + build + test**

Run: `pnpm install && pnpm -r build && pnpm typecheck && pnpm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "[REFACTOR] Extract CLI into @night-orch/cli (published bin)"
```

### Task 7.2: Identify TUI's in-process imports

- [ ] **Step 1: Grep**

Run: `grep -rln "from '@night-orch/backend\|from '@night-orch/runner" packages/cli/src/tui`
Expected: list of files that touch backend/runner directly.

- [ ] **Step 2: Categorize each import**

For each file, note whether it imports:
- pure types (fine — leave; will re-route through `@night-orch/shared` in step 7.3)
- live data fetch (Runs, Issues, Settings) — must replace with HTTP call in 7.4
- side-effectful actions (start loop, cancel run) — must replace with HTTP call in 7.4

Save the categorization to a scratch file (e.g. `/tmp/tui-deps.md`) — used as the work-list for 7.4.

- [ ] **Step 3: No commit — analysis only.**

### Task 7.3: Add HTTP client in `packages/cli/src/tui/client.ts`

- [ ] **Step 1: Write failing test**

`packages/cli/test/tui/client.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createTuiClient } from '../../src/tui/client.js'

let backend: Server
let port: number

beforeAll(async () => {
  backend = createServer((req, res) => {
    if (req.url === '/api/runs' && req.method === 'GET') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'r1', status: 'completed' }] }))
    } else if (req.url === '/api/health') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'ok', version: '0.0.0', process: 'backend', uptime_seconds: 1, maintenance: false }))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const addr = backend.address()
  if (typeof addr !== 'object' || !addr) throw new Error('no addr')
  port = addr.port
})

afterAll(() => backend.close())

describe('createTuiClient', () => {
  it('GETs /api/runs and returns parsed data', async () => {
    const client = createTuiClient({ baseUrl: `http://127.0.0.1:${port}`, token: 't' })
    const runs = await client.listRuns()
    expect(runs).toEqual([{ id: 'r1', status: 'completed' }])
  })
  it('GETs /api/health', async () => {
    const client = createTuiClient({ baseUrl: `http://127.0.0.1:${port}`, token: 't' })
    const h = await client.health()
    expect(h.status).toBe('ok')
  })
})
```

Run: expect FAIL.

- [ ] **Step 2: Implement `packages/cli/src/tui/client.ts`**

```typescript
import { HealthStatusSchema, type HealthStatus } from '@night-orch/shared'

export interface TuiClientOptions {
  baseUrl: string
  token: string
}

export interface TuiClient {
  listRuns(): Promise<Array<{ id: string; status: string }>>
  health(): Promise<HealthStatus>
  events(onEvent: (ev: { type: string; data: unknown }) => void): { close: () => void }
}

export function createTuiClient(opts: TuiClientOptions): TuiClient {
  const headers = { authorization: `Bearer ${opts.token}` }

  return {
    async listRuns() {
      const res = await fetch(`${opts.baseUrl}/api/runs`, { headers })
      if (!res.ok) throw new Error(`listRuns ${res.status}`)
      const body = await res.json() as { data: Array<{ id: string; status: string }> }
      return body.data
    },
    async health() {
      const res = await fetch(`${opts.baseUrl}/api/health`, { headers })
      if (!res.ok) throw new Error(`health ${res.status}`)
      const raw = await res.json()
      return HealthStatusSchema.parse(raw)
    },
    events(onEvent) {
      const ctrl = new AbortController()
      const conn = fetch(`${opts.baseUrl}/api/events`, { headers, signal: ctrl.signal })
        .then(async (res) => {
          if (!res.body) return
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            // Split SSE frames on blank-line delimiter
            let idx: number
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim()
              if (dataLine) {
                try { onEvent(JSON.parse(dataLine) as { type: string; data: unknown }) } catch { /* skip */ }
              }
            }
          }
        })
        .catch(() => { /* aborted */ })
      return { close: () => { ctrl.abort(); void conn } }
    },
  }
}
```

- [ ] **Step 3: Test PASS, commit**

```bash
git add packages/cli/src/tui/client.ts packages/cli/test/tui/client.test.ts
git commit -m "[FEATURE] TUI HTTP client with REST + SSE support"
```

### Task 7.4: Rewire TUI screens to use `client`

- [ ] **Step 1: For each TUI screen identified in 7.2, replace direct backend imports with `client.X()` calls**

Work file-by-file. For each:
- Remove `import { … } from '@night-orch/backend'` (except pure types via `@night-orch/shared`)
- Inject `client: TuiClient` via prop or context
- Replace data calls with awaited client methods, manage loading state via React `useState` + `useEffect`
- Replace event subscriptions with `client.events(handler)`

Estimated: 5–15 screens. Each is one commit:

```bash
git add packages/cli/src/tui/<screen>.tsx
git commit -m "[REFACTOR] Rewire <screen> TUI screen to TuiClient"
```

- [ ] **Step 2: Update TUI entrypoint** to construct the client from config:

```typescript
import { createTuiClient } from './client.js'

const client = createTuiClient({
  baseUrl: process.env.NIGHT_ORCH_API_URL ?? `http://127.0.0.1:3200`,
  token: process.env.NIGHT_ORCH_TOKEN ?? readTokenFromDataDir(),
})
```

- [ ] **Step 3: Final commit after all screens migrated**

```bash
git add -A
git commit -m "[REFACTOR] TUI consumes backend exclusively via TuiClient (no in-process imports)"
```

### Task 7.5: Verify TUI works against running backend

- [ ] **Step 1: Start the system**

Run: `pnpm dev` (with web enabled or `--no-web`).
Wait for backend up + port file written.

- [ ] **Step 2: Run TUI in another shell**

Run: `pnpm dev tui`
Expected: TUI screens render data fetched from backend. SSE events stream when runs change.

- [ ] **Step 3: Kill backend, observe TUI behavior**

Expected: TUI shows error/reconnect indicator. After backend respawns, TUI auto-recovers (or instructs user to re-run).

- [ ] **Step 4: No commit — verification.**

### Task 7.6: M7 acceptance check

- [ ] **Step 1: `grep -rln "@night-orch/backend\|@night-orch/runner" packages/cli/src/tui`**

Expected: empty (no direct backend/runner imports from TUI).

- [ ] **Step 2: `pnpm typecheck && pnpm lint && pnpm test`** all pass.

- [ ] **Step 3: No commit.**

---

# M8 — Health endpoint formalization

Goal: every child exposes the `HealthStatus` contract from M6.2 on `/health`. Runner uses `/health` (replacing ad-hoc probes) + fork-IPC heartbeats. Three consecutive failures → restart.

### Task 8.1: Backend `/health` route

- [ ] **Step 1: Write failing test**

`packages/backend/test/http/health.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HealthStatusSchema } from '@night-orch/shared'
import { startBackendHttp } from '../../src/http/bin.js'

let handle: { port: number; stop: () => Promise<void> }
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'health-'))
  handle = await startBackendHttp({ host: '127.0.0.1', port: 0, dataDir: dir })
})

afterAll(async () => {
  await handle.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /health', () => {
  it('returns a payload matching HealthStatusSchema', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const parsed = HealthStatusSchema.parse(body)
    expect(parsed.process).toBe('backend')
    expect(parsed.maintenance).toBe(false)
  })
})
```

Run: expect FAIL.

- [ ] **Step 2: Implement `/health` route**

In the backend HTTP handler (likely a route registry in `packages/backend/src/http/`), add:

```typescript
import type { HealthStatus } from '@night-orch/shared'

const startedAt = Date.now()

export function healthHandler(): HealthStatus {
  return {
    status: 'ok',
    version: process.env.npm_package_version ?? '0.0.0',
    process: 'backend',
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    maintenance: getMaintenanceFlag(),
    details: {
      db: dbHealthy() ? 'ok' : 'down',
      queueDepth: getQueueDepth(),
      activeRuns: getActiveRunCount(),
    },
  }
}
```

Wire it to `GET /health` in the route registry. `getMaintenanceFlag`, `dbHealthy`, `getQueueDepth`, `getActiveRunCount` come from existing backend modules — wire to real implementations.

- [ ] **Step 3: Test PASS, commit**

```bash
git add packages/backend
git commit -m "[FEATURE] Backend GET /health returns HealthStatus per shared schema"
```

### Task 8.2: Web `/health` route

- [ ] **Step 1: Write failing test**

`packages/web/test/health.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HealthStatusSchema } from '@night-orch/shared'
import { startWebServer } from '../src/bin.js'

let handle: { port: number; stop: () => Promise<void> }
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webhealth-'))
  writeFileSync(join(dir, 'index.html'), '<title>spa</title>')
  handle = await startWebServer({
    host: '127.0.0.1',
    port: 0,
    spaDir: dir,
    backendUrl: 'http://127.0.0.1:1',
  })
})
afterAll(async () => { await handle.stop(); rmSync(dir, { recursive: true, force: true }) })

describe('GET /health on web', () => {
  it('returns HealthStatus payload (NOT proxied)', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(res.status).toBe(200)
    const parsed = HealthStatusSchema.parse(await res.json())
    expect(parsed.process).toBe('web')
  })
})
```

Run: expect FAIL.

- [ ] **Step 2: Add `/health` short-circuit to `packages/web/src/bin.ts`**

In the request dispatcher:

```typescript
const url = req.url ?? '/'
if (url === '/health') {
  const payload: HealthStatus = {
    status: 'ok',
    version: process.env.npm_package_version ?? '0.0.0',
    process: 'web',
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    maintenance: false,
  }
  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
  return
}
if (url.startsWith('/api/')) { proxy(req, res); return }
staticHandler(req, res)
```

(Track `startedAt = Date.now()` at module load.)

- [ ] **Step 3: Test PASS, commit**

```bash
git add packages/web
git commit -m "[FEATURE] Web /health returns local HealthStatus (not proxied)"
```

### Task 8.3: Replace ad-hoc runner health probes with `HealthStatusSchema`-validated probe

- [ ] **Step 1: Update `packages/runner/src/health-probe.ts`**

Replace existing `probeHealthEndpoint` body so that, on receipt of the response body, it parses with `HealthStatusSchema.safeParse(...)`. If parse fails, mark probe as failed.

```typescript
import { HealthStatusSchema, type HealthStatus } from '@night-orch/shared'

export interface HealthProbeResult {
  ok: boolean
  detail: string
  status?: HealthStatus
}

export async function probeHealthEndpoint(url: string, opts: { timeoutMs?: number } = {}): Promise<HealthProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status}` }
    const raw = await res.json()
    const parsed = HealthStatusSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, detail: `schema mismatch: ${parsed.error.message}` }
    return { ok: parsed.data.status === 'ok', detail: parsed.data.status, status: parsed.data }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 2: Update supervisor to call probe every 5s, restart after 3 consecutive failures**

In `packages/runner/src/supervisor.ts`, add a per-child probe loop:

```typescript
private startHealthProbeFor(child: ManagedChild, url: string): void {
  let failures = 0
  const interval = setInterval(async () => {
    if (child.status !== 'running') return
    const r = await probeHealthEndpoint(url)
    if (r.ok) {
      failures = 0
      return
    }
    failures += 1
    logger.warn({ name: child.name, detail: r.detail, failures }, 'health probe failed')
    if (failures >= 3) {
      logger.error({ name: child.name }, 'restarting after 3 consecutive health failures')
      failures = 0
      child.process?.kill('SIGTERM')
    }
  }, 5_000)
  child.healthInterval = interval
}
```

Clear the interval in `shutdown()` / when child exits.

- [ ] **Step 3: Write failing test**

`packages/runner/test/health-probe.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { probeHealthEndpoint } from '../src/health-probe.js'

describe('probeHealthEndpoint', () => {
  it('returns ok=true when body matches HealthStatusSchema and status=ok', async () => {
    const srv = createServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        status: 'ok', version: '0', process: 'backend', uptime_seconds: 1, maintenance: false,
      }))
    })
    srv.listen(0, '127.0.0.1')
    await once(srv, 'listening')
    const addr = srv.address()
    if (typeof addr !== 'object' || !addr) throw new Error('no addr')
    const r = await probeHealthEndpoint(`http://127.0.0.1:${addr.port}/health`)
    srv.close()
    expect(r.ok).toBe(true)
  })

  it('returns ok=false on schema mismatch', async () => {
    const srv = createServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'whatever' }))
    })
    srv.listen(0, '127.0.0.1')
    await once(srv, 'listening')
    const addr = srv.address()
    if (typeof addr !== 'object' || !addr) throw new Error('no addr')
    const r = await probeHealthEndpoint(`http://127.0.0.1:${addr.port}/health`)
    srv.close()
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/schema/)
  })
})
```

Run: expect tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/runner
git commit -m "[FEATURE] Runner health probe validates against shared HealthStatusSchema + 3-strike restart"
```

### Task 8.4: M8 smoke test — verify restart on synthetic failure

- [ ] **Step 1: Add a debug endpoint to backend that returns 500 for 3 calls in a row**

For testing only. Behind an env var: `if (process.env.NIGHT_ORCH_FORCE_HEALTH_FAIL) { res.statusCode = 500; res.end(); return }`

- [ ] **Step 2: Start system with the flag, observe restart**

Run: `NIGHT_ORCH_FORCE_HEALTH_FAIL=1 pnpm dev`
Expected: ~15s after start (3 probes × 5s), runner logs "restarting after 3 consecutive health failures" and respawns backend.

- [ ] **Step 3: Remove the debug endpoint**

Don't commit the debug hook. Use a vitest test instead if regression coverage is desired.

- [ ] **Step 4: No commit needed — verification only.**

### Task 8.5: M8 acceptance check

- [ ] **Step 1: Full verification**

Run: `pnpm install && pnpm -r build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 2: Confirm success criteria from spec section "Success criteria"**

Read `docs/superpowers/specs/2026-06-05-process-topology-ipc-design.md` "Success criteria" section. For each item, manually verify:

1. **Web process can be killed and respawned without interrupting any active run.** — verified in 5.6 step 3.
2. **Backend can be killed mid-run; on restart resumes from last checkpoint.** — start a long-running task, kill backend, observe resume.
3. **TUI shows live state via SSE within 1 second of an event.** — start TUI, trigger an event (manual loop), observe latency.
4. **`@night-orch/shared` is single source of truth — no duplicate type defs.** — `grep -rln "interface Run\|type Run = " packages/backend packages/web packages/runner packages/cli` returns empty (or only re-exports from shared).
5. **`runner` ≤ 800 LOC, depends only on shared (no engine/DB code).** — `wc -l packages/runner/src/*.ts | tail -1` ≤ 800; `cat packages/runner/package.json | jq .dependencies` shows only `@night-orch/shared` + `pino` (+ allowed config-loader dep if kept).
6. **Shared purity lint rule passes.** — `pnpm lint` clean.

- [ ] **Step 3: No new commit — M8 done.**

---

## Final acceptance (across all migrations)

- [ ] **Step 1: Run full pipeline**

```bash
pnpm install
pnpm -r build
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:build
```

Expected: all green.

- [ ] **Step 2: End-to-end behavior unchanged**

Run `pnpm dev doctor` and `pnpm dev status` against an existing dataDir. Expected: same output as pre-migration.

- [ ] **Step 3: Confirm git log shape**

Run: `git log --oneline --since="<start-date>" | wc -l`
Expected: ~50–80 commits, each task-scoped, none reverted.

- [ ] **Step 4: No final commit — plan is complete when M1–M8 acceptance checks all green.**

---

## Out of scope — follow-up plans

These remain to be planned and executed after this migration:

1. **Staged update FSM** — drain semantics, version handshake, rollback, `night-orch update` CLI subcommand.
2. **Config hot-reload** — chokidar watcher, apply matrix (which fields live-applicable), validation-before-apply, project config discovery.
3. **TUI separate package** — lift `packages/cli/src/tui/` to `packages/tui/` once API surface stabilizes.
4. **Auth model expansion** — token rotation, scoped tokens, multi-user.
5. **SSE backpressure** — ring buffer sizing, slow-client eviction, `Last-Event-ID` replay limits.
6. **Publish strategy** — which internal packages go public on npm, semver coupling.
