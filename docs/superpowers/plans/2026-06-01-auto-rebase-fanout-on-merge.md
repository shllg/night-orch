# Auto-Rebase Fan-Out on Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a tracked PR merges into its base branch, automatically queue a `rebase` attempt for every open sibling PR (same repo, same base branch, tracked, non-terminal), so the human-AFK loop picks up upstream changes and resolves conflicts without manual `/orch rebase` commands.

**Architecture:** Poll-driven (no webhooks). Detection happens at the two existing sites that already observe a PR merge transition — `ops/sync.ts` (`prState === 'merged'` branches) and `merge-queue/runner.ts::transitionMergedRuns`. Both call a new `fanoutRebaseAfterMerge()` helper. The helper does a two-stage filter: a pure `selectFanoutCandidates()` over local `runs` rows, then an asynchronous forge enrichment step that fetches each candidate PR to confirm `state === 'open'` and matching `baseBranch` (which is **not** stored on `runs`). It calls the existing `queueRebase()` once per surviving candidate (extended with a `triggeredBy` field for bot-comment text), classifies the result, and records an idempotency row in a new `rebase_fanouts(repo, source_pr_number)` table only when every sibling was either queued or hit a known-harmless skip. Per-repo opt-in via `repos[].autoRebaseOnMerge` config; new optional `repos[].labels.rebasing` field gives a distinct visual signal during rebase attempts — routed through the existing `RunRecord.operationIntent` field that is already persisted (`'rebase'` for rebase attempts).

**Tech Stack:** TypeScript (strict, ESM), zod, better-sqlite3 (WAL), pino, prom-client, vitest. All file imports use `.js` extension. Background reading: `CONTEXT.md` (root) and `docs/adr/0001-auto-rebase-fanout-on-merge.md`.

---

## Codebase facts the plan depends on (verified before writing)

- The `runs` table has **no `base_branch` column** (`src/state/migrations/001-initial.ts:5`). `RunRecord` (`src/state/runs.ts:23`) has no `baseBranch` field. **Decision: fetch `baseBranch` from the forge per candidate PR via `ForgeAdapter.getPR(repo, prNumber)`**, capped by `maxFanout` so the call count is bounded. Do not add a new column for v1.
- Migrations are registered in the `MIGRATIONS` constant in `src/state/db.ts:35`. The runner (`runMigrations`) is private (`src/state/db.ts:92`). Tests open in-memory DBs through `initDatabase(':memory:')`.
- `RunOperationIntent` (`src/state/runs.ts:20`) is already `'auto' | 'continue' | 'retry' | 'rebase' | 'refresh'` and is **persisted on the `runs` row** as `operation_intent` (column map at `src/state/runs.ts:147`). Reuse this — do not invent a new `AttemptIntent`.
- `markRunning` (`src/poller/run-state-controller.ts:117`) is the actual `queued → running` transition site; it must read `operationIntent` from the run row and pass it to `transitionLabels`.
- `buildLabelConfig` (`src/labels/config.ts:28`) currently drops `rebasing`. Must be extended.
- `RunManager.create` (`src/state/runs.ts:160`) requires `{ repo, issueNumber, issueNodeId, planner, coder, reviewer }`. It does not accept `status`, `branchName`, `prNumber`. Tests must use the real signature and then update via the `RunManager` setters (e.g. `updatePullRequest`, `updateWorktree`) to put a row into a fan-out-relevant state.
- `RetentionEngine` (`src/ops/retention.ts:30`) is a class with `prune(options): RetentionResult`. Dry-run short-circuits at line 45 — counts must be reported without performing the delete.
- Config schema requires `version` and `github.tokenEnv` (`src/config/schema.ts:649` and related) when parsing a whole `ConfigSchema`. Schema-level tests must include them.
- `processMergeQueue` (`src/merge-queue/runner.ts:32`) is invoked from `src/poller/reaction-processor.ts:53` with `(db, forge, repoConfig)`. `config`, `botUser`, and `metrics` exist at the caller's scope and must be threaded through if fan-out is to fire from the merge-queue path.

Any deviation from these facts requires updating the plan, not the code.

---

## File Structure

**New files:**
- `src/state/migrations/030-rebase-fanouts.ts` — DDL for `rebase_fanouts` table.
- `src/state/rebase-fanouts.ts` — `RebaseFanoutManager` (DB access for the new table).
- `src/ops/fanout-rebase.ts` — `fanoutRebaseAfterMerge()` orchestrator + pure `selectFanoutCandidates()`.
- `test/state/migrations/030-rebase-fanouts.test.ts`
- `test/state/rebase-fanouts.test.ts`
- `test/ops/fanout-rebase.test.ts`

**Modified files:**
- `src/config/schema.ts` — add `AutoRebaseOnMergeSchema`, attach to `RepoConfigSchema`; add `rebasing` to `LabelsSchema`.
- `src/state/db.ts` — register migration 030 in the `MIGRATIONS` constant.
- `src/labels/transitions.ts` — extend `LabelConfig` with `rebasing`; route `intent === 'rebase'` to `config.rebasing` in `computeLabelMutation`.
- `src/labels/config.ts` — propagate optional `rebasing` through `buildLabelConfig`.
- `src/labels/manager.ts` — accept optional `intent` parameter on `transitionLabels`, forward to `computeLabelMutation`.
- `src/labels/bootstrap.ts` — register the `rebasing` label role.
- `src/poller/run-state-controller.ts` — read `RunRecord.operationIntent` and pass it into the `markRunning` label transition.
- `src/ops/sync.ts` — pass `operationIntent` through the mismatch-correction path so the new label is not stripped; call `fanoutRebaseAfterMerge` (awaited) after detecting `prState === 'merged'`.
- `src/ops/rebase-and-check.ts` — add `triggeredBy` option to `queueRebase`, vary comment text, plumb `intent: 'rebase'` to `transitionLabels`.
- `src/merge-queue/runner.ts` + `src/poller/reaction-processor.ts` — thread `config`/`botUser`/`metrics` through `processMergeQueue`; have `transitionMergedRuns` await fan-out invocations.
- `src/metrics/service.ts` + `src/metrics/collectors.ts` — add `incRebaseFanout()`, `incRebaseFanoutSibling()`.
- `src/ops/retention.ts` — prune `rebase_fanouts` older than 90d; return count; handle dry-run.
- `docs/CONFIGURATION.md`, `docs/OVERVIEW.md`, `docs/USAGE.md`, `examples/config.example.yaml`. `CONTEXT.md` and `docs/adr/0001-auto-rebase-fanout-on-merge.md` already written.

---

## Task 1: Migration 030 — `rebase_fanouts` table

**Files:**
- Create: `src/state/migrations/030-rebase-fanouts.ts`
- Modify: `src/state/db.ts` (register in `MIGRATIONS`)
- Test: `test/state/migrations/030-rebase-fanouts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/state/migrations/030-rebase-fanouts.test.ts
import { describe, it, expect } from 'vitest'
import { initDatabase } from '../../../src/state/db.js'

describe('migration 030 rebase_fanouts', () => {
  it('creates table with correct columns and composite primary key', () => {
    const db = initDatabase(':memory:')
    const cols = db.prepare("PRAGMA table_info('rebase_fanouts')").all() as Array<{ name: string; type: string; pk: number }>
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.repo).toMatchObject({ type: 'TEXT', pk: 1 })
    expect(byName.source_pr_number).toMatchObject({ type: 'INTEGER', pk: 2 })
    expect(byName.fanned_out_at).toMatchObject({ type: 'TEXT' })
    expect(byName.siblings_queued).toMatchObject({ type: 'INTEGER' })
  })

  it('enforces uniqueness on (repo, source_pr_number)', () => {
    const db = initDatabase(':memory:')
    const stmt = db.prepare("INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued) VALUES (?, ?, ?, ?)")
    stmt.run('owner/repo', 42, new Date().toISOString(), 3)
    expect(() => stmt.run('owner/repo', 42, new Date().toISOString(), 1)).toThrow(/UNIQUE|PRIMARY/i)
  })

  it('allows the same source_pr_number across different repos', () => {
    const db = initDatabase(':memory:')
    const stmt = db.prepare("INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued) VALUES (?, ?, ?, ?)")
    stmt.run('owner/a', 42, new Date().toISOString(), 1)
    expect(() => stmt.run('owner/b', 42, new Date().toISOString(), 1)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run, verify failure**

```bash
pnpm test -- --run test/state/migrations/030-rebase-fanouts.test.ts
```

Expected: FAIL — `rebase_fanouts` table missing.

- [ ] **Step 3: Implement the migration**

```typescript
// src/state/migrations/030-rebase-fanouts.ts
import type Database from 'better-sqlite3'

/**
 * Idempotency marker for merge fan-out. Written once per source PR after
 * the fan-out loop completes. Crash-mid-loop is safe: per-sibling guards
 * in `selectFanoutCandidates` (no in-flight rebase attempt) prevent
 * double-queueing on the retry pass.
 *
 * Pruned by `ops/retention.ts` after 90 days.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rebase_fanouts (
      repo TEXT NOT NULL,
      source_pr_number INTEGER NOT NULL,
      fanned_out_at TEXT NOT NULL,
      siblings_queued INTEGER NOT NULL,
      PRIMARY KEY (repo, source_pr_number)
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rebase_fanouts_age
    ON rebase_fanouts(fanned_out_at)
  `)
}
```

- [ ] **Step 4: Register the migration in `src/state/db.ts`**

Open `src/state/db.ts`. At the top, alongside the existing migration imports, add:

```typescript
import { up as up030 } from './migrations/030-rebase-fanouts.js'
```

In the `MIGRATIONS` array (starts at `src/state/db.ts:35`), append a new entry mirroring the existing entries' shape (verify the actual object shape — the codebase may use `{ version, up }`, `{ name, up }`, or an inline tuple). Whatever the form, the new entry sits last in the array.

- [ ] **Step 5: Run all migration-related tests**

```bash
pnpm test -- --run test/state/
pnpm typecheck
```

Expected: PASS for `030-rebase-fanouts.test.ts` and every existing migration test.

- [ ] **Step 6: Commit**

```bash
git add src/state/migrations/030-rebase-fanouts.ts src/state/db.ts test/state/migrations/030-rebase-fanouts.test.ts
git commit -m "[FEATURE] Add rebase_fanouts table migration (030)"
```

---

## Task 2: `RebaseFanoutManager` — DB accessor

**Files:**
- Create: `src/state/rebase-fanouts.ts`
- Test: `test/state/rebase-fanouts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/state/rebase-fanouts.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../../src/state/db.js'
import { RebaseFanoutManager } from '../../src/state/rebase-fanouts.js'
import type Database from 'better-sqlite3'

describe('RebaseFanoutManager', () => {
  let db: Database.Database
  let mgr: RebaseFanoutManager

  beforeEach(() => {
    db = initDatabase(':memory:')
    mgr = new RebaseFanoutManager(db)
  })

  it('has() returns false when no row exists', () => {
    expect(mgr.has('owner/repo', 42)).toBe(false)
  })

  it('has() returns true after mark()', () => {
    mgr.mark('owner/repo', 42, 3)
    expect(mgr.has('owner/repo', 42)).toBe(true)
  })

  it('mark() is idempotent — second call does not throw', () => {
    mgr.mark('owner/repo', 42, 3)
    expect(() => mgr.mark('owner/repo', 42, 5)).not.toThrow()
  })

  it('mark() persists siblings_queued count on first write', () => {
    mgr.mark('owner/repo', 42, 7)
    const row = db.prepare(
      'SELECT siblings_queued FROM rebase_fanouts WHERE repo = ? AND source_pr_number = ?',
    ).get('owner/repo', 42) as { siblings_queued: number }
    expect(row.siblings_queued).toBe(7)
  })

  it('pruneOlderThan() deletes rows older than the cutoff, returns the count', () => {
    const old = new Date(Date.now() - 100 * 86400 * 1000).toISOString()
    const recent = new Date().toISOString()
    db.prepare('INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued) VALUES (?, ?, ?, ?)')
      .run('owner/repo', 1, old, 0)
    db.prepare('INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued) VALUES (?, ?, ?, ?)')
      .run('owner/repo', 2, recent, 0)
    expect(mgr.pruneOlderThan(90)).toBe(1)
    expect(mgr.has('owner/repo', 1)).toBe(false)
    expect(mgr.has('owner/repo', 2)).toBe(true)
  })

  it('pruneOlderThan(days, { dryRun: true }) returns count without deleting', () => {
    const old = new Date(Date.now() - 100 * 86400 * 1000).toISOString()
    db.prepare('INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued) VALUES (?, ?, ?, ?)')
      .run('owner/repo', 1, old, 0)
    expect(mgr.pruneOlderThan(90, { dryRun: true })).toBe(1)
    expect(mgr.has('owner/repo', 1)).toBe(true)
  })
})
```

- [ ] **Step 2: Run, verify failure**

```bash
pnpm test -- --run test/state/rebase-fanouts.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/state/rebase-fanouts.ts
import type Database from 'better-sqlite3'

/**
 * Idempotency tracker for merge fan-out events. Keys on
 * `(repo, source_pr_number)` so each merged source PR triggers fan-out
 * exactly once across the daemon's lifetime.
 */
export class RebaseFanoutManager {
  constructor(private readonly db: Database.Database) {}

  has(repo: string, sourcePrNumber: number): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM rebase_fanouts WHERE repo = ? AND source_pr_number = ? LIMIT 1')
      .get(repo, sourcePrNumber) as { x: number } | undefined
    return row !== undefined
  }

  mark(repo: string, sourcePrNumber: number, siblingsQueued: number): void {
    this.db
      .prepare(
        `INSERT INTO rebase_fanouts (repo, source_pr_number, fanned_out_at, siblings_queued)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo, source_pr_number) DO NOTHING`,
      )
      .run(repo, sourcePrNumber, new Date().toISOString(), siblingsQueued)
  }

  /**
   * Returns the number of rows older than {@link days} days.
   * If `opts.dryRun` is true, performs no delete and returns the count
   * that *would* have been deleted — used by retention's dry-run mode.
   */
  pruneOlderThan(days: number, opts: { dryRun?: boolean } = {}): number {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString()
    if (opts.dryRun) {
      const row = this.db
        .prepare('SELECT COUNT(*) AS c FROM rebase_fanouts WHERE fanned_out_at < ?')
        .get(cutoff) as { c: number }
      return row.c
    }
    const result = this.db.prepare('DELETE FROM rebase_fanouts WHERE fanned_out_at < ?').run(cutoff)
    return result.changes
  }
}
```

- [ ] **Step 4: Verify**

```bash
pnpm test -- --run test/state/rebase-fanouts.test.ts
pnpm typecheck
```

Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/state/rebase-fanouts.ts test/state/rebase-fanouts.test.ts
git commit -m "[FEATURE] Add RebaseFanoutManager for fan-out idempotency"
```

---

## Task 3: Config schema — `AutoRebaseOnMergeSchema` + `labels.rebasing`

**Files:**
- Modify: `src/config/schema.ts`
- Test: `test/config/schema-auto-rebase.test.ts` (new)

The test must include every field required by `ConfigSchema` — at minimum `version`, `storage.dbPath`, `github.tokenEnv`, and the per-repo required keys. Inspect `src/config/schema.ts` once at the top of the task to confirm the actual required-field set before authoring the fixture.

- [ ] **Step 1: Inspect required fields**

```bash
grep -n "required\|\.min(\|tokenEnv" src/config/schema.ts | head -20
```

Use the output to build a minimal-valid `BASE` fixture below.

- [ ] **Step 2: Write the failing tests**

```typescript
// test/config/schema-auto-rebase.test.ts
import { describe, it, expect } from 'vitest'
import { ConfigSchema } from '../../src/config/schema.js'

/**
 * Build a minimal-valid fixture. Update if ConfigSchema gains new required
 * top-level fields.
 */
function base() {
  return {
    version: 1,
    storage: { dbPath: ':memory:' },
    github: { tokenEnv: 'GITHUB_TOKEN' },
    repos: [
      { repo: 'owner/r', localPath: '/tmp/r' },
    ],
  }
}

describe('autoRebaseOnMerge config', () => {
  it('defaults enabled=false when block is absent', () => {
    const parsed = ConfigSchema.parse(base())
    const repo = parsed.repos[0]!
    expect(repo.autoRebaseOnMerge.enabled).toBe(false)
    expect(repo.autoRebaseOnMerge.maxFanout).toBe(20)
    expect(repo.autoRebaseOnMerge.strategy).toBe('rebase')
    expect(repo.autoRebaseOnMerge.maxChainLength).toBeUndefined()
  })

  it('accepts a fully-populated block', () => {
    const cfg = base()
    cfg.repos[0] = {
      ...cfg.repos[0],
      autoRebaseOnMerge: { enabled: true, maxFanout: 5, strategy: 'merge', maxChainLength: 12 },
    } as typeof cfg.repos[0]
    const parsed = ConfigSchema.parse(cfg)
    expect(parsed.repos[0]!.autoRebaseOnMerge).toEqual({
      enabled: true, maxFanout: 5, strategy: 'merge', maxChainLength: 12,
    })
  })

  it('rejects maxFanout < 1', () => {
    const cfg = base()
    cfg.repos[0] = { ...cfg.repos[0], autoRebaseOnMerge: { maxFanout: 0 } } as typeof cfg.repos[0]
    expect(() => ConfigSchema.parse(cfg)).toThrow()
  })

  it('rejects unknown strategy', () => {
    const cfg = base()
    cfg.repos[0] = { ...cfg.repos[0], autoRebaseOnMerge: { strategy: 'squash' as 'merge' } } as typeof cfg.repos[0]
    expect(() => ConfigSchema.parse(cfg)).toThrow()
  })

  it('accepts labels.rebasing string', () => {
    const cfg = base()
    cfg.repos[0] = { ...cfg.repos[0], labels: { ready: 'no:ready', rebasing: 'no:rebasing' } } as typeof cfg.repos[0]
    expect(ConfigSchema.parse(cfg).repos[0]!.labels.rebasing).toBe('no:rebasing')
  })

  it('leaves labels.rebasing undefined when absent', () => {
    expect(ConfigSchema.parse(base()).repos[0]!.labels.rebasing).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run, verify failure**

```bash
pnpm test -- --run test/config/schema-auto-rebase.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Add schema entries**

In `src/config/schema.ts`, after the `MergeQueueSchema` definition (around line 452):

```typescript
const AutoRebaseOnMergeSchema = z.object({
  enabled: z.boolean().default(false),
  maxFanout: z.number().int().min(1).max(200).default(20),
  strategy: z.enum(['merge', 'rebase']).default('rebase'),
  maxChainLength: z.number().int().min(1).max(100).optional(),
}).default({})
```

Extend `LabelsSchema` (around line 189) by appending:

```typescript
  rebasing: z.string().optional(),
```

Add the field to `RepoConfigSchema` (next to `mergeQueue` at line 485):

```typescript
  autoRebaseOnMerge: AutoRebaseOnMergeSchema,
```

Add the matching `z.unknown().optional()` entry in the partial-update block (around line 832):

```typescript
  autoRebaseOnMerge: z.unknown().optional(),
```

- [ ] **Step 5: Verify**

```bash
pnpm test -- --run test/config/schema-auto-rebase.test.ts
pnpm typecheck
```

Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts test/config/schema-auto-rebase.test.ts
git commit -m "[FEATURE] Add autoRebaseOnMerge config + labels.rebasing field"
```

---

## Task 4: Label flow — extend `computeLabelMutation`, `buildLabelConfig`, `transitionLabels`, `markRunning`, `sync` corrections

`RunRecord.operationIntent` is already persisted (`src/state/runs.ts:20`). Reuse it. The label must apply at the `queued → running` transition the dispatcher actually performs (`run-state-controller.ts:117::markRunning`), AND must not be stripped by sync's mismatch correction.

**Files:**
- Modify: `src/labels/transitions.ts`
- Modify: `src/labels/config.ts`
- Modify: `src/labels/manager.ts`
- Modify: `src/labels/bootstrap.ts`
- Modify: `src/poller/run-state-controller.ts`
- Modify: `src/ops/sync.ts` (mismatch-correction path)
- Test: `test/labels/transitions.test.ts` (extend), `test/labels/config.test.ts` (extend if present, else create)

- [ ] **Step 1: Write failing tests for `computeLabelMutation`**

Append to `test/labels/transitions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeLabelMutation, type LabelConfig } from '../../src/labels/transitions.js'

const cfg: LabelConfig = {
  ready: ['no:ready'],
  running: 'no:running',
  blocked: 'no:blocked',
  needsHuman: 'no:needs-human',
  reviewReady: 'no:review-ready',
  error: 'no:error',
  retry: 'no:retry',
  planning: 'no:planning',
  mergeQueued: 'no:merge-queued',
  merging: 'no:merging',
  mergeFailed: 'no:merge-failed',
}

describe('computeLabelMutation rebase intent', () => {
  it('uses labels.rebasing on queued→running when intent=rebase and rebasing configured', () => {
    const mut = computeLabelMutation('queued', 'running', ['no:ready'], { ...cfg, rebasing: 'no:rebasing' }, undefined, 'rebase')
    expect(mut.add).toContain('no:rebasing')
    expect(mut.add).not.toContain('no:running')
    expect(mut.remove).toContain('no:ready')
  })

  it('falls back to labels.running when labels.rebasing is undefined', () => {
    const mut = computeLabelMutation('queued', 'running', ['no:ready'], cfg, undefined, 'rebase')
    expect(mut.add).toContain('no:running')
    expect(mut.add).not.toContain('no:rebasing')
  })

  it('strips no:rebasing on any non-running transition when configured', () => {
    const withReb = { ...cfg, rebasing: 'no:rebasing' }
    const mut = computeLabelMutation('running', 'review_ready', ['no:rebasing'], withReb, undefined, 'rebase')
    expect(mut.remove).toContain('no:rebasing')
    expect(mut.add).toContain('no:review-ready')
  })

  it('does not add no:rebasing for non-rebase intents', () => {
    const mut = computeLabelMutation('queued', 'running', ['no:ready'], { ...cfg, rebasing: 'no:rebasing' }, undefined, 'retry')
    expect(mut.add).toContain('no:running')
    expect(mut.add).not.toContain('no:rebasing')
  })
})
```

- [ ] **Step 2: Extend `LabelConfig` + `computeLabelMutation`**

In `src/labels/transitions.ts`:

```typescript
export interface LabelConfig {
  ready: string[]
  running: string
  blocked: string
  needsHuman: string
  reviewReady: string
  error: string
  retry: string
  planning: string
  mergeQueued: string
  merging: string
  mergeFailed: string
  rebasing?: string
}

/** Mirrors `RunOperationIntent` from `state/runs.ts` for label routing.
 *  Only `'rebase'` is consequential today; the rest are passed through. */
export type LabelIntent = 'auto' | 'continue' | 'retry' | 'rebase' | 'refresh'

export function computeLabelMutation(
  _from: RunStatus,
  to: RunStatus,
  currentLabels: string[],
  config: LabelConfig,
  blockReason?: BlockedReason,
  intent?: LabelIntent,
): LabelMutation {
  const current = new Set(currentLabels)
  let add: string[] = []
  let remove: string[] = []

  const useRebaseLabel = intent === 'rebase' && typeof config.rebasing === 'string' && config.rebasing.length > 0

  switch (to) {
    case 'running':
      if (useRebaseLabel) {
        add = [config.rebasing!]
        // Make sure both signals never coexist on the issue.
        remove = [...config.ready, config.running, config.blocked, config.needsHuman, config.error, config.retry]
      } else {
        add = [config.running]
        remove = [...config.ready, config.blocked, config.needsHuman, config.error, config.retry]
        if (config.rebasing) remove.push(config.rebasing)
      }
      break
    case 'blocked':
      if (blockReason && isHumanRequired(blockReason)) {
        add = [config.blocked, config.needsHuman]
        remove = [config.running]
      } else {
        add = [config.blocked]
        remove = [config.running, config.needsHuman]
      }
      if (config.rebasing) remove.push(config.rebasing)
      break
    case 'review_ready':
      add = [config.reviewReady]
      remove = [...config.ready, config.running, config.blocked, config.needsHuman, config.error, config.retry]
      if (config.rebasing) remove.push(config.rebasing)
      break
    case 'error':
      add = [config.error]
      remove = [config.running]
      if (config.rebasing) remove.push(config.rebasing)
      break
    case 'completed':
      remove = [...config.ready, config.running, config.blocked, config.needsHuman, config.reviewReady, config.error, config.retry]
      if (config.rebasing) remove.push(config.rebasing)
      break
    case 'queued':
      add = [...config.ready]
      remove = [config.running, config.blocked, config.needsHuman, config.error, config.reviewReady, config.retry]
      if (config.rebasing) remove.push(config.rebasing)
      break
  }

  add = add.filter((l) => !current.has(l))
  remove = remove.filter((l) => current.has(l))

  return { add, remove }
}
```

- [ ] **Step 3: Propagate `rebasing` through `buildLabelConfig`**

In `src/labels/config.ts:36`, extend the return to include:

```typescript
rebasing: typeof source.rebasing === 'string' && source.rebasing.length > 0 ? source.rebasing : undefined,
```

Add a unit test in `test/labels/config.test.ts` (create if absent):

```typescript
import { describe, it, expect } from 'vitest'
import { buildLabelConfig } from '../../src/labels/config.js'

describe('buildLabelConfig', () => {
  it('propagates labels.rebasing when present', () => {
    const result = buildLabelConfig({ labels: { ready: ['no:ready'], rebasing: 'no:rebasing' } } as any)
    expect(result.rebasing).toBe('no:rebasing')
  })

  it('leaves rebasing undefined when absent', () => {
    const result = buildLabelConfig({ labels: { ready: ['no:ready'] } } as any)
    expect(result.rebasing).toBeUndefined()
  })
})
```

- [ ] **Step 4: Extend `transitionLabels` to forward `intent`**

In `src/labels/manager.ts`, add an optional last parameter `intent?: LabelIntent` to `transitionLabels` and forward it to `computeLabelMutation`. All existing call sites continue to compile (parameter optional).

- [ ] **Step 5: Wire `markRunning` to read intent from the run row**

In `src/poller/run-state-controller.ts`, modify `markRunning` to look up the current `operationIntent` and pass it through:

```typescript
async markRunning(runId: string, fields: Omit<RunStateTransitionFields, 'status'>, from: RunStatus): Promise<void> {
  this.params.runManager.transitionRunState(runId, {
    ...fields,
    status: 'running',
  })
  const run = this.params.runManager.getById(runId)
  await transitionLabels(
    this.params.forge,
    this.params.issueRepo,
    this.params.issue.number,
    this.params.issue.labels ?? [],
    from,
    'running',
    buildLabelConfig(this.params.repoConfig, this.params.issue.labels ?? []),
    /* blockReason */ undefined,
    run?.operationIntent,
  )
  await this.params.pollerNotifier.runStarted(this.params.repoConfig.repo, this.params.issue)
}
```

- [ ] **Step 6: Audit `sync.ts` mismatch correction**

Inspect `src/ops/sync.ts` around line 475 (the label-mismatch correction site). Where it builds a target label set per status, ensure it loads `RunRecord.operationIntent` for the run and passes it into `transitionLabels` so a rebase-running row does not lose its `rebasing` label when sync rebuilds the canonical label set. If the function currently computes labels from status alone, extend its signature accordingly and update all callers within `sync.ts`.

- [ ] **Step 7: Register the new label role in bootstrap**

In `src/labels/bootstrap.ts`, extend the `LabelRole` union with `'rebasing'`. After the existing `mergeFailed` registration, add:

```typescript
if (repoConfig.labels.rebasing) {
  add(repoConfig.labels.rebasing, 'rebasing')
}
```

- [ ] **Step 8: Run label suite + typecheck**

```bash
pnpm test -- --run test/labels/ test/poller/ test/ops/sync.test.ts
pnpm typecheck
```

Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/labels/ src/poller/run-state-controller.ts src/ops/sync.ts test/labels/ test/poller/
git commit -m "[FEATURE] Route operationIntent through label transitions"
```

---

## Task 5: Pure function — `selectFanoutCandidates`

`baseBranch` is **not** on `RunRecord`. The pure filter therefore cannot decide base-branch membership. It does the cheap, deterministic part: status + termination + not-source + no-in-flight-rebase. A separate async step (Task 7) fetches each surviving candidate's PR from the forge to confirm `state === 'open'` and `baseBranch === trigger.baseBranch`.

**Files:**
- Create: `src/ops/fanout-rebase.ts` (skeleton — pure function only)
- Test: `test/ops/fanout-rebase.test.ts` (skeleton — selection tests only)

- [ ] **Step 1: Write the failing tests**

```typescript
// test/ops/fanout-rebase.test.ts
import { describe, it, expect } from 'vitest'
import { selectFanoutCandidates, type SiblingRunLike } from '../../src/ops/fanout-rebase.js'

const baseRun = (overrides: Partial<SiblingRunLike>): SiblingRunLike => ({
  id: 'run-x',
  repo: 'owner/repo',
  issueNumber: 1,
  prNumber: 100,
  status: 'review_ready',
  operationIntent: 'auto',
  hasOpenRebaseAttempt: false,
  terminatedAt: null,
  ...overrides,
})

describe('selectFanoutCandidates', () => {
  it('excludes the source PR itself', () => {
    const runs: SiblingRunLike[] = [
      baseRun({ id: 'r1', prNumber: 42, issueNumber: 1 }),
      baseRun({ id: 'r2', prNumber: 100, issueNumber: 2 }),
    ]
    const out = selectFanoutCandidates(runs, { sourcePrNumber: 42 }, { maxFanout: 10 })
    expect(out.map((r) => r.id)).toEqual(['r2'])
  })

  it('only keeps status in {review_ready, blocked, error}', () => {
    const statuses = ['queued', 'running', 'review_ready', 'blocked', 'error', 'completed'] as const
    const runs: SiblingRunLike[] = statuses.map((s, i) => baseRun({ id: `r${i}`, prNumber: 100 + i, status: s }))
    const out = selectFanoutCandidates(runs, { sourcePrNumber: 42 }, { maxFanout: 10 })
    expect(out.map((r) => r.status).sort()).toEqual(['blocked', 'error', 'review_ready'])
  })

  it('excludes runs with terminatedAt set', () => {
    const runs: SiblingRunLike[] = [
      baseRun({ id: 'r1', prNumber: 100, terminatedAt: '2026-05-30T12:00:00Z' }),
      baseRun({ id: 'r2', prNumber: 101 }),
    ]
    const out = selectFanoutCandidates(runs, { sourcePrNumber: 42 }, { maxFanout: 10 })
    expect(out.map((r) => r.id)).toEqual(['r2'])
  })

  it('excludes runs with an open rebase attempt', () => {
    const runs: SiblingRunLike[] = [
      baseRun({ id: 'r1', prNumber: 100, hasOpenRebaseAttempt: true }),
      baseRun({ id: 'r2', prNumber: 101, hasOpenRebaseAttempt: false }),
    ]
    const out = selectFanoutCandidates(runs, { sourcePrNumber: 42 }, { maxFanout: 10 })
    expect(out.map((r) => r.id)).toEqual(['r2'])
  })

  it('excludes runs without a prNumber (nothing to rebase yet)', () => {
    const runs: SiblingRunLike[] = [
      baseRun({ id: 'r1', prNumber: null }),
      baseRun({ id: 'r2', prNumber: 101 }),
    ]
    const out = selectFanoutCandidates(runs, { sourcePrNumber: 42 }, { maxFanout: 10 })
    expect(out.map((r) => r.id)).toEqual(['r2'])
  })

  it('caps result length at maxFanout, deterministic ascending issueNumber', () => {
    const runs: SiblingRunLike[] = [50, 10, 30, 20, 40].map((n, i) =>
      baseRun({ id: `r${i}`, prNumber: 100 + i, issueNumber: n }),
    )
    const out = selectFanoutCandidates(runs, { sourcePrNumber: 42 }, { maxFanout: 3 })
    expect(out.length).toBe(3)
    expect(out.map((r) => r.issueNumber)).toEqual([10, 20, 30])
  })

  it('returns empty array when no candidates match', () => {
    expect(selectFanoutCandidates([], { sourcePrNumber: 42 }, { maxFanout: 10 })).toEqual([])
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- --run test/ops/fanout-rebase.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// src/ops/fanout-rebase.ts
import type { RunStatus, RunOperationIntent } from '../state/runs.js'

/** Minimal shape consumed by candidate selection — keeps the function
 *  trivially testable. baseBranch is NOT here because `RunRecord` does
 *  not carry it; Task 7 fetches it from the forge per candidate. */
export interface SiblingRunLike {
  id: string
  repo: string
  issueNumber: number
  prNumber: number | null
  status: RunStatus
  operationIntent: RunOperationIntent
  hasOpenRebaseAttempt: boolean
  terminatedAt: string | null
}

export interface FanoutTrigger {
  sourcePrNumber: number
}

export interface FanoutLimits {
  maxFanout: number
}

const ELIGIBLE_STATUSES: ReadonlySet<RunStatus> = new Set(['review_ready', 'blocked', 'error'])

/**
 * Pure pre-filter: which sibling runs are *worth* fetching from the forge
 * for base-branch and PR-state confirmation? No I/O, no DB.
 * Deterministic ordering by `issueNumber` ascending so `maxFanout`
 * truncation is predictable.
 */
export function selectFanoutCandidates(
  runs: readonly SiblingRunLike[],
  trigger: FanoutTrigger,
  limits: FanoutLimits,
): SiblingRunLike[] {
  const filtered = runs.filter((r) =>
    r.prNumber !== null
    && r.prNumber !== trigger.sourcePrNumber
    && r.terminatedAt === null
    && ELIGIBLE_STATUSES.has(r.status)
    && !r.hasOpenRebaseAttempt,
  )
  filtered.sort((a, b) => a.issueNumber - b.issueNumber)
  return filtered.slice(0, limits.maxFanout)
}
```

- [ ] **Step 4: Verify**

```bash
pnpm test -- --run test/ops/fanout-rebase.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/ops/fanout-rebase.ts test/ops/fanout-rebase.test.ts
git commit -m "[FEATURE] Add pure selectFanoutCandidates filter"
```

---

## Task 6: Extend `queueRebase` with `triggeredBy`, intent-aware comment, chain-exhaustion comment

**Files:**
- Modify: `src/ops/rebase-and-check.ts`
- Test: `test/ops/rebase-and-check.test.ts` (new — focused on the new option)

`queueRebase` already returns `{ queued: false }` for benign reasons (no branch, already queued/running, chain exhausted via caught `createFollowupAttempt` failure). The fan-out orchestrator (Task 7) classifies these. This task focuses on the comment-text change and surfacing chain-exhaustion via a dedicated bot comment when the trigger is fan-out.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/ops/rebase-and-check.test.ts
import { describe, it, expect, vi } from 'vitest'
import { initDatabase } from '../../src/state/db.js'
import { queueRebase } from '../../src/ops/rebase-and-check.js'
import { RunManager } from '../../src/state/runs.js'

function seedRunWithBranch(db: ReturnType<typeof initDatabase>) {
  const mgr = new RunManager(db)
  const run = mgr.create({
    repo: 'owner/r', issueNumber: 7, issueNodeId: 'node-7',
    planner: 'claude', coder: 'codex', reviewer: 'codex',
  })
  mgr.updateWorktree(run.id, { branchName: 'orch/owner-r/7' })
  mgr.updatePullRequest(run.id, { prNumber: 100 })
  mgr.updateLifecycle(run.id, { status: 'review_ready' })
  return run
}

const fakeRepoCfg = {
  repo: 'owner/r',
  baseBranch: 'develop',
  labels: {
    ready: ['no:ready'], running: 'no:running', blocked: 'no:blocked',
    needsHuman: 'no:needs-human', reviewReady: 'no:review-ready',
    error: 'no:error', retry: 'no:retry', planning: 'no:planning',
    mergeQueued: 'no:merge-queued', merging: 'no:merging', mergeFailed: 'no:merge-failed',
  },
} as any

describe('queueRebase with triggeredBy', () => {
  it('posts a fan-out-flavoured comment referencing the source PR', async () => {
    const db = initDatabase(':memory:')
    seedRunWithBranch(db)
    const commentBodies: string[] = []
    const forge = {
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
      commentOnIssue: vi.fn(async (_r: string, _n: number, body: string) => { commentBodies.push(body) }),
    } as any
    await queueRebase(db, forge, fakeRepoCfg, 7, '', {
      triggeredBy: { kind: 'merge-fanout', sourcePr: 42 },
    })
    expect(commentBodies.join('\n')).toMatch(/PR #42 merged/i)
    expect(commentBodies.join('\n')).toMatch(/develop/)
  })

  it('records actor=fanout when triggeredBy is set and actor unspecified', async () => {
    const db = initDatabase(':memory:')
    const run = seedRunWithBranch(db)
    const forge = {
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
      commentOnIssue: vi.fn(async () => undefined),
    } as any
    await queueRebase(db, forge, fakeRepoCfg, 7, '', { triggeredBy: { kind: 'merge-fanout', sourcePr: 42 } })
    const row = db.prepare("SELECT actor FROM run_log_events WHERE run_id = ? AND kind = 'rebase' ORDER BY id DESC LIMIT 1").get(run.id) as { actor: string } | undefined
    expect(row?.actor).toBe('fanout')
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- --run test/ops/rebase-and-check.test.ts
```

- [ ] **Step 3: Implement option + comment text**

In `src/ops/rebase-and-check.ts::queueRebase`, extend the `options` parameter:

```typescript
options: {
  check?: boolean
  strategyOverride?: UpdateStrategy
  actor?: string
  maxAttemptChainLength?: number
  triggeredBy?: { kind: 'merge-fanout'; sourcePr: number }
} = {},
```

Replace the `commentStatus(...)` call near the end of `queueRebase` with:

```typescript
const message = options.triggeredBy?.kind === 'merge-fanout'
  ? `PR #${options.triggeredBy.sourcePr} merged into \`${repoConfig.baseBranch}\` — queuing rebase to pick up upstream changes. The branch will be rebased, verified, and any breakage fixed automatically.`
  : 'Queued for rebase and re-evaluation. The branch will be rebased onto the latest base, verified, and if anything breaks the coder will fix it.'
await commentStatus(forge, issueRepo, issueNumber, botUser, message)
```

Update the `recordUserAction` call:

```typescript
recordUserAction(db, {
  runId: queuedRun.id,
  kind: 'rebase',
  actor: options.actor ?? (options.triggeredBy ? 'fanout' : 'manual'),
  details: {
    ...(options.strategyOverride ? { strategy: options.strategyOverride } : {}),
    ...(options.triggeredBy ? { triggeredBy: options.triggeredBy } : {}),
  },
})
```

The label-transition call inside `queueRebase` flips status to `queued` (`from … to 'queued'`). The `'rebasing'` label appears only on the later `queued → running` transition handled by `markRunning` (Task 4). No `intent` plumbing is required at the `queueRebase` label-transition site.

- [ ] **Step 4: Add chain-exhaustion comment hook (fan-out only)**

In `queueRebase`, where `createFollowupAttempt` is wrapped in `try/catch` (returns `{ queued: false }` on failure), detect the chain-exhaustion error class and — only when `options.triggeredBy?.kind === 'merge-fanout'` — post a one-shot bot comment:

```typescript
} catch (err) {
  logger.warn({ runId: run.id, err }, 'Failed to queue rebase attempt')
  if (options.triggeredBy?.kind === 'merge-fanout' && isChainExhausted(err)) {
    await commentStatus(
      forge, issueRepo, issueNumber, botUser,
      `Auto-rebase skipped: attempt chain length cap reached. Manual review needed — this branch has diverged enough from \`${repoConfig.baseBranch}\` that automatic rebase-and-fix exceeds the configured budget.`,
    )
  }
  return { queued: false, reason: isChainExhausted(err) ? 'chain_exhausted' : 'Run state changed while queuing rebase' }
}
```

Define `isChainExhausted(err)` near the bottom of the file as a narrow check against the error shape thrown by `createFollowupAttempt` when the cap is hit (`src/state/attempts.ts:283` — inspect the actual error message/class and match on that). Add a TODO comment if the error is currently untyped; the matching can be string-based against the thrown `Error.message` for v1.

- [ ] **Step 5: Verify**

```bash
pnpm test -- --run test/ops/rebase-and-check.test.ts
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/ops/rebase-and-check.ts test/ops/rebase-and-check.test.ts
git commit -m "[FEATURE] Add triggeredBy option + chain-exhaustion comment to queueRebase"
```

---

## Task 7: `fanoutRebaseAfterMerge` orchestrator (with async forge enrichment + result classification)

The orchestrator runs three phases:

1. **Pre-filter** via `selectFanoutCandidates` over the repo's live top-level runs.
2. **Forge enrichment**: for each candidate, fetch the PR via `ForgeAdapter.getPR(repo, prNumber)`. Keep only those with `state === 'open'` AND `baseBranch === sourcePR.baseBranch`. The source PR's `baseBranch` is the trigger — it is passed in by the caller (it already knows the merged PR's base branch).
3. **Queue + classify**: call `queueRebase` per survivor; tabulate:
   - `queued === true` → counted as `queued`.
   - `queued === false` with reason in `{ 'Run is already queued', 'Run is already running', 'chain_exhausted', 'No run with branch found for this issue' }` → counted as `skipped` (not a failure).
   - Any other `queued === false` reason → counted as `failure`.
   - Thrown exception → counted as `failure`, logged.

Mark the fan-out (`RebaseFanoutManager.mark`) only when `failure === 0`. A partial run with skips is fine and should not re-trigger next cycle.

**Files:**
- Modify: `src/ops/fanout-rebase.ts` (add orchestrator)
- Modify: `src/state/runs.ts` (add `listLiveTopLevelByRepo` helper)
- Modify: `src/state/attempts.ts` (add `hasOpenRebaseAttempt` helper)
- Test: `test/ops/fanout-rebase.test.ts` (extend)

- [ ] **Step 1: Add `RunManager.listLiveTopLevelByRepo`**

In `src/state/runs.ts`, add:

```typescript
listLiveTopLevelByRepo(repo: string): RunRecord[] {
  const rows = this.db.prepare(
    `SELECT * FROM runs
     WHERE repo = ?
       AND parent_run_id IS NULL
       AND terminated_at IS NULL`,
  ).all(repo) as RawRunRow[]
  return rows.map((r) => this.mapRow(r))
}
```

Test in `test/state/runs.test.ts` (extend):

```typescript
it('listLiveTopLevelByRepo returns only non-terminated top-level rows for the repo', () => {
  // seed: live, terminated, sub-run — assert only the live top-level row comes back
})
```

- [ ] **Step 2: Add `hasOpenRebaseAttempt` to `src/state/attempts.ts`**

Inspect the table schema first to find the actual intent column name (`operation_intent`):

```bash
grep -n "operation_intent\|operationIntent" src/state/runs.ts src/state/migrations/ | head
```

Then add:

```typescript
export function hasOpenRebaseAttempt(db: Database.Database, repo: string, issueNumber: number): boolean {
  const row = db.prepare(
    `SELECT 1 AS x FROM runs
     WHERE repo = ?
       AND issue_number = ?
       AND operation_intent = 'rebase'
       AND terminated_at IS NULL
       AND status IN ('queued', 'running')
     LIMIT 1`,
  ).get(repo, issueNumber) as { x: number } | undefined
  return row !== undefined
}
```

Test in `test/state/attempts.test.ts` (extend). Cover positive case (queued rebase), positive case (running rebase), negative case (terminated rebase), negative case (non-rebase intent).

- [ ] **Step 3: Write orchestrator tests**

```typescript
// Append to test/ops/fanout-rebase.test.ts
import { vi, describe, it, expect } from 'vitest'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { RebaseFanoutManager } from '../../src/state/rebase-fanouts.js'
import { fanoutRebaseAfterMerge } from '../../src/ops/fanout-rebase.js'

function makeRepoCfg(over: { enabled?: boolean; maxFanout?: number; maxChainLength?: number } = {}) {
  return {
    repo: 'owner/r',
    baseBranch: 'develop',
    localPath: '/tmp/r',
    forge: 'github' as const,
    labels: { ready: ['no:ready'], running: 'no:running', blocked: 'no:blocked',
      needsHuman: 'no:needs-human', reviewReady: 'no:review-ready', error: 'no:error',
      retry: 'no:retry', planning: 'no:planning', mergeQueued: 'no:merge-queued',
      merging: 'no:merging', mergeFailed: 'no:merge-failed' },
    autoRebaseOnMerge: {
      enabled: over.enabled ?? true,
      maxFanout: over.maxFanout ?? 20,
      strategy: 'rebase' as const,
      ...(over.maxChainLength !== undefined ? { maxChainLength: over.maxChainLength } : {}),
    },
  } as any
}

const fakeConfig = { loop: { maxAttemptChainLength: 5 } } as any

function seedSibling(db: ReturnType<typeof initDatabase>, issueNumber: number, prNumber: number, status: 'review_ready' | 'blocked' | 'error' = 'review_ready') {
  const mgr = new RunManager(db)
  const run = mgr.create({ repo: 'owner/r', issueNumber, issueNodeId: `n${issueNumber}`, planner: 'claude', coder: 'codex', reviewer: 'codex' })
  mgr.updateWorktree(run.id, { branchName: `orch/owner-r/${issueNumber}` })
  mgr.updatePullRequest(run.id, { prNumber })
  mgr.updateLifecycle(run.id, { status })
  return run
}

describe('fanoutRebaseAfterMerge', () => {
  it('no-ops when autoRebaseOnMerge.enabled === false', async () => {
    const db = initDatabase(':memory:')
    const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: 'ok' })
    const forge = { getPR: vi.fn() } as any
    const fanouts = new RebaseFanoutManager(db)
    const res = await fanoutRebaseAfterMerge({
      db, repoConfig: makeRepoCfg({ enabled: false }), forge, config: fakeConfig,
      sourcePrNumber: 42, baseBranch: 'develop', botUser: 'bot', queueRebase, fanouts,
    })
    expect(res.skippedDisabled).toBe(true)
    expect(queueRebase).not.toHaveBeenCalled()
    expect(forge.getPR).not.toHaveBeenCalled()
  })

  it('no-ops when the fan-out was already recorded', async () => {
    const db = initDatabase(':memory:')
    const fanouts = new RebaseFanoutManager(db); fanouts.mark('owner/r', 42, 0)
    const queueRebase = vi.fn()
    const res = await fanoutRebaseAfterMerge({
      db, repoConfig: makeRepoCfg(), forge: {} as any, config: fakeConfig,
      sourcePrNumber: 42, baseBranch: 'develop', botUser: 'bot', queueRebase, fanouts,
    })
    expect(res.alreadyFannedOut).toBe(true)
    expect(queueRebase).not.toHaveBeenCalled()
  })

  it('keeps only PRs that are open AND match the source baseBranch (forge enrichment)', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    seedSibling(db, 2, 102)
    seedSibling(db, 3, 103)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: 'ok' })
    const forge = {
      getPR: vi.fn(async (_repo: string, n: number) => {
        if (n === 101) return { state: 'open', baseBranch: 'develop' }
        if (n === 102) return { state: 'open', baseBranch: 'main' }       // wrong base
        if (n === 103) return { state: 'closed', baseBranch: 'develop' }  // not open
        throw new Error('unexpected PR')
      }),
    } as any
    const res = await fanoutRebaseAfterMerge({
      db, repoConfig: makeRepoCfg(), forge, config: fakeConfig,
      sourcePrNumber: 99, baseBranch: 'develop', botUser: 'bot', queueRebase, fanouts,
    })
    expect(res.queued).toBe(1)
    expect(queueRebase).toHaveBeenCalledTimes(1)
    const issueArg = queueRebase.mock.calls[0]![3]
    expect(issueArg).toBe(1)
    expect(fanouts.has('owner/r', 99)).toBe(true)
  })

  it('counts queueRebase queued=false with benign reason as skipped, still marks fan-out', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockResolvedValue({ queued: false, reason: 'Run is already queued' })
    const forge = { getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'develop' }) } as any
    const res = await fanoutRebaseAfterMerge({
      db, repoConfig: makeRepoCfg(), forge, config: fakeConfig,
      sourcePrNumber: 99, baseBranch: 'develop', botUser: 'bot', queueRebase, fanouts,
    })
    expect(res.queued).toBe(0)
    expect(res.skipped).toBe(1)
    expect(res.failures).toBe(0)
    expect(fanouts.has('owner/r', 99)).toBe(true)
  })

  it('does not mark fan-out when any queueRebase throws — leaves room to retry next cycle', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockRejectedValue(new Error('forge unreachable'))
    const forge = { getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'develop' }) } as any
    const res = await fanoutRebaseAfterMerge({
      db, repoConfig: makeRepoCfg(), forge, config: fakeConfig,
      sourcePrNumber: 99, baseBranch: 'develop', botUser: 'bot', queueRebase, fanouts,
    })
    expect(res.failures).toBe(1)
    expect(fanouts.has('owner/r', 99)).toBe(false)
  })

  it('marks fan-out when zero siblings qualify so we do not re-scan', async () => {
    const db = initDatabase(':memory:')
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn()
    const forge = { getPR: vi.fn() } as any
    const res = await fanoutRebaseAfterMerge({
      db, repoConfig: makeRepoCfg(), forge, config: fakeConfig,
      sourcePrNumber: 99, baseBranch: 'develop', botUser: 'bot', queueRebase, fanouts,
    })
    expect(res.queued).toBe(0)
    expect(fanouts.has('owner/r', 99)).toBe(true)
  })

  it('uses maxChainLength override when provided, otherwise 2× loop.maxAttemptChainLength', async () => {
    const db = initDatabase(':memory:')
    seedSibling(db, 1, 101)
    const fanouts = new RebaseFanoutManager(db)
    const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: 'ok' })
    const forge = { getPR: vi.fn().mockResolvedValue({ state: 'open', baseBranch: 'develop' }) } as any
    await fanoutRebaseAfterMerge({
      db, repoConfig: makeRepoCfg({ maxChainLength: 12 }), forge, config: fakeConfig,
      sourcePrNumber: 99, baseBranch: 'develop', botUser: 'bot', queueRebase, fanouts,
    })
    expect(queueRebase.mock.calls[0]![5].maxAttemptChainLength).toBe(12)

    queueRebase.mockClear()
    fanouts.pruneOlderThan(0)
    await fanoutRebaseAfterMerge({
      db, repoConfig: makeRepoCfg(), forge, config: fakeConfig,
      sourcePrNumber: 99, baseBranch: 'develop', botUser: 'bot', queueRebase, fanouts,
    })
    expect(queueRebase.mock.calls[0]![5].maxAttemptChainLength).toBe(10) // 2 × 5
  })
})
```

- [ ] **Step 4: Verify failure**

```bash
pnpm test -- --run test/ops/fanout-rebase.test.ts
```

- [ ] **Step 5: Implement orchestrator**

Append to `src/ops/fanout-rebase.ts`:

```typescript
import type Database from 'better-sqlite3'
import type { ForgeAdapter } from '../forge/types.js'
import type { Config, RepoConfig } from '../config/schema.js'
import { RunManager } from '../state/runs.js'
import { RebaseFanoutManager } from '../state/rebase-fanouts.js'
import { hasOpenRebaseAttempt } from '../state/attempts.js'
import { queueRebase as defaultQueueRebase } from './rebase-and-check.js'
import { logger } from '../utils/logger.js'
import type { MetricsService } from '../metrics/service.js'

const BENIGN_SKIP_REASONS: ReadonlySet<string> = new Set([
  'Run is already queued',
  'Run is already running',
  'chain_exhausted',
  'No run with branch found for this issue',
])

export interface FanoutDeps {
  db: Database.Database
  repoConfig: RepoConfig
  forge: ForgeAdapter
  config: Config
  sourcePrNumber: number
  /** baseBranch of the merged source PR — used as the filter for siblings. */
  baseBranch: string
  botUser: string
  queueRebase?: typeof defaultQueueRebase
  fanouts?: RebaseFanoutManager
  metrics?: MetricsService
}

export interface FanoutResult {
  queued: number
  skipped: number
  failures: number
  alreadyFannedOut: boolean
  skippedDisabled: boolean
}

/**
 * Inspect open sibling runs and queue a rebase attempt on each PR whose
 * forge state is `open` and whose `baseBranch` matches the source PR's.
 *
 * Idempotent across crashes: writes `rebase_fanouts` marker only when no
 * sibling failed. Per-sibling skip-guard via {@link hasOpenRebaseAttempt}
 * prevents double-queue on retry.
 *
 * Never throws — failures are logged and reflected in the returned
 * counters.
 */
export async function fanoutRebaseAfterMerge(deps: FanoutDeps): Promise<FanoutResult> {
  const { db, repoConfig, forge, config, sourcePrNumber, baseBranch, botUser } = deps
  const queueRebaseFn = deps.queueRebase ?? defaultQueueRebase
  const fanouts = deps.fanouts ?? new RebaseFanoutManager(db)

  if (!repoConfig.autoRebaseOnMerge.enabled) {
    return { queued: 0, skipped: 0, failures: 0, alreadyFannedOut: false, skippedDisabled: true }
  }
  if (fanouts.has(repoConfig.repo, sourcePrNumber)) {
    return { queued: 0, skipped: 0, failures: 0, alreadyFannedOut: true, skippedDisabled: false }
  }

  const runMgr = new RunManager(db)
  const allRuns = runMgr.listLiveTopLevelByRepo(repoConfig.repo)
  const preFiltered = selectFanoutCandidates(
    allRuns.map((r) => ({
      id: r.id,
      repo: r.repo,
      issueNumber: r.issueNumber,
      prNumber: r.prNumber,
      status: r.status,
      operationIntent: r.operationIntent,
      hasOpenRebaseAttempt: hasOpenRebaseAttempt(db, r.repo, r.issueNumber),
      terminatedAt: null,
    })),
    { sourcePrNumber },
    { maxFanout: repoConfig.autoRebaseOnMerge.maxFanout },
  )

  // Forge enrichment: keep only OPEN PRs targeting the source baseBranch.
  const enriched: typeof preFiltered = []
  for (const c of preFiltered) {
    try {
      const pr = await forge.getPR(repoConfig.repo, c.prNumber!)
      if (pr.state === 'open' && pr.baseBranch === baseBranch) enriched.push(c)
    } catch (err) {
      logger.warn({ repo: repoConfig.repo, prNumber: c.prNumber, err }, 'Fan-out: failed to fetch PR; skipping')
      // Skip — does not count as failure (forge transient errors should not block fan-out marker).
    }
  }

  let queued = 0
  let skipped = 0
  let failures = 0
  const maxChainLength =
    repoConfig.autoRebaseOnMerge.maxChainLength ?? config.loop.maxAttemptChainLength * 2

  for (const sibling of enriched) {
    try {
      const result = await queueRebaseFn(db, forge, repoConfig, sibling.issueNumber, botUser, {
        strategyOverride: repoConfig.autoRebaseOnMerge.strategy,
        actor: 'fanout',
        maxAttemptChainLength: maxChainLength,
        triggeredBy: { kind: 'merge-fanout', sourcePr: sourcePrNumber },
      })
      if (result.queued) {
        queued += 1
      } else if (BENIGN_SKIP_REASONS.has(result.reason)) {
        skipped += 1
      } else {
        failures += 1
        logger.warn({ repo: repoConfig.repo, sibling: sibling.issueNumber, reason: result.reason },
          'Fan-out queueRebase returned non-benign skip')
      }
    } catch (err) {
      failures += 1
      logger.warn({ repo: repoConfig.repo, sourcePr: sourcePrNumber, sibling: sibling.issueNumber, err },
        'Fanout queueRebase threw — will retry next cycle')
    }
  }

  if (failures === 0) fanouts.mark(repoConfig.repo, sourcePrNumber, queued)

  deps.metrics?.incRebaseFanout(repoConfig.repo, baseBranch)
  for (let i = 0; i < queued; i += 1) deps.metrics?.incRebaseFanoutSibling(repoConfig.repo)

  logger.info(
    { repo: repoConfig.repo, sourcePr: sourcePrNumber, baseBranch,
      candidates: enriched.length, queued, skipped, failures },
    'Merge fan-out evaluated',
  )

  return { queued, skipped, failures, alreadyFannedOut: false, skippedDisabled: false }
}
```

- [ ] **Step 6: Verify**

```bash
pnpm test -- --run test/ops/fanout-rebase.test.ts test/state/runs.test.ts test/state/attempts.test.ts
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/ops/fanout-rebase.ts src/state/runs.ts src/state/attempts.ts test/ops/ test/state/
git commit -m "[FEATURE] Add fanoutRebaseAfterMerge orchestrator with forge enrichment"
```

---

## Task 8: Wire fan-out into `ops/sync.ts` (awaited)

**Files:**
- Modify: `src/ops/sync.ts`
- Test: `test/ops/sync.test.ts` (extend)

- [ ] **Step 1: Add injection point**

Add an optional `fanoutRebaseAfterMerge` to whichever dep object the `SyncEngine`'s constructor or `createSyncEngine` factory takes. Default to the real implementation imported from `./fanout-rebase.js`. This lets tests inject a spy.

- [ ] **Step 2: Invoke at both merge-detection sites, awaited**

At `src/ops/sync.ts:174` (`reconcileStaleRun`) and `src/ops/sync.ts:237` (`reconcileNonTerminalRun`), immediately after the `this.markCompleted(...)` calls for the `prState === 'merged'` branch — and only when `!dryRun` — add:

```typescript
if (!dryRun && run.pr_number !== null) {
  const repoConfig = this.findRepoConfig(run.repo)
  if (repoConfig) {
    try {
      const sourcePR = await forge.getPR(run.repo, run.pr_number)
      await this.fanoutRebaseAfterMerge({
        db: this.db,
        repoConfig,
        forge,
        config: this.config,
        sourcePrNumber: run.pr_number,
        baseBranch: sourcePR.baseBranch,
        botUser: await this.resolveBotUser(forge),
        metrics: this.metrics,
      })
    } catch (err) {
      logger.warn({ repo: run.repo, sourcePr: run.pr_number, err }, 'Fan-out invocation failed')
    }
  }
}
```

`findRepoConfig`, `resolveBotUser`, and access to `this.config`/`this.metrics` may need minor additions to the engine — keep them tightly scoped. The `forge.getPR` call here is intentional: it gives us the source PR's `baseBranch` so the orchestrator's enrichment step can compare against it.

- [ ] **Step 3: Write the test**

```typescript
describe('sync merge fan-out', () => {
  it('invokes fanoutRebaseAfterMerge once when a run transitions to merged', async () => {
    const fanoutSpy = vi.fn().mockResolvedValue({ queued: 2, skipped: 0, failures: 0, alreadyFannedOut: false, skippedDisabled: false })
    // Seed a run with prNumber=42, status='running'. Stub the forge so
    // getPR returns { state: 'merged', baseBranch: 'develop' }.
    // Construct the engine with { fanoutRebaseAfterMerge: fanoutSpy }.
    await engine.runOnce({ dryRun: false })
    expect(fanoutSpy).toHaveBeenCalledTimes(1)
    expect(fanoutSpy.mock.calls[0]![0].sourcePrNumber).toBe(42)
    expect(fanoutSpy.mock.calls[0]![0].baseBranch).toBe('develop')
  })

  it('does not invoke fan-out in dryRun mode', async () => {
    const fanoutSpy = vi.fn()
    await engine.runOnce({ dryRun: true })
    expect(fanoutSpy).not.toHaveBeenCalled()
  })
})
```

Adapt the seeding to the helpers used by the existing `test/ops/sync.test.ts`.

- [ ] **Step 4: Verify**

```bash
pnpm test -- --run test/ops/sync.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/ops/sync.ts test/ops/sync.test.ts
git commit -m "[FEATURE] Wire merge fan-out into sync reconciliation"
```

---

## Task 9: Plumb deps through `processMergeQueue` and wire fan-out into `transitionMergedRuns`

`processMergeQueue` (`src/merge-queue/runner.ts:32`) currently receives only `(db, forge, repoConfig)`. The caller (`src/poller/reaction-processor.ts:53`) has `config`, `botUser`, and `metrics` in scope. Thread them through.

**Files:**
- Modify: `src/merge-queue/runner.ts`
- Modify: `src/poller/reaction-processor.ts`
- Test: `test/merge-queue/runner.test.ts` (extend or create)

- [ ] **Step 1: Extend `processMergeQueue` signature**

```typescript
export async function processMergeQueue(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  deps: {
    config: Config
    botUser: string
    metrics?: MetricsService
    fanoutRebaseAfterMerge?: typeof defaultFanout
  },
): Promise<void>
```

Update the only caller in `reaction-processor.ts:53` to pass the new `deps`.

- [ ] **Step 2: Refactor `transitionMergedRuns` to await fan-out**

```typescript
async function transitionMergedRuns(
  db: Database.Database,
  forge: ForgeAdapter,
  repoConfig: RepoConfig,
  mergedPrNumbers: number[],
  deps: {
    config: Config
    botUser: string
    metrics?: MetricsService
    fanoutRebaseAfterMerge?: typeof defaultFanout
  },
): Promise<void> {
  if (mergedPrNumbers.length === 0) return
  const placeholders = mergedPrNumbers.map(() => '?').join(', ')
  // ... existing status-flip SQL block unchanged ...

  const fn = deps.fanoutRebaseAfterMerge ?? defaultFanout
  for (const prNumber of mergedPrNumbers) {
    try {
      const sourcePR = await forge.getPR(repoConfig.repo, prNumber)
      await fn({
        db, repoConfig, forge, config: deps.config,
        sourcePrNumber: prNumber, baseBranch: sourcePR.baseBranch,
        botUser: deps.botUser, metrics: deps.metrics,
      })
    } catch (err) {
      logger.warn({ repo: repoConfig.repo, sourcePr: prNumber, err }, 'Fanout from merge-queue failed')
    }
  }
}
```

Update the existing call (line 116) — it now needs to be `await`ed and forwarded `deps`.

- [ ] **Step 3: Write the test**

```typescript
describe('merge-queue transitionMergedRuns fan-out', () => {
  it('invokes fanoutRebaseAfterMerge once per merged PR number, awaited', async () => {
    const fanoutSpy = vi.fn().mockResolvedValue({ queued: 0, skipped: 0, failures: 0, alreadyFannedOut: false, skippedDisabled: false })
    const forge = { getPR: vi.fn().mockResolvedValue({ state: 'merged', baseBranch: 'develop' }) } as any
    // Set up in-memory DB and call the exported wrapper (export
    // transitionMergedRuns if necessary, or invoke via processMergeQueue
    // with a hand-built batch).
    await transitionMergedRuns(db, forge, repoConfig, [101, 102], {
      config: fakeConfig, botUser: 'bot', fanoutRebaseAfterMerge: fanoutSpy,
    })
    expect(fanoutSpy).toHaveBeenCalledTimes(2)
    expect(new Set(fanoutSpy.mock.calls.map((c) => c[0].sourcePrNumber))).toEqual(new Set([101, 102]))
  })
})
```

If `transitionMergedRuns` is currently file-private, export it for testing.

- [ ] **Step 4: Verify**

```bash
pnpm test -- --run test/merge-queue/
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/merge-queue/runner.ts src/poller/reaction-processor.ts test/merge-queue/
git commit -m "[FEATURE] Wire merge fan-out into merge-queue transitions (awaited)"
```

---

## Task 10: Metrics — `incRebaseFanout` + `incRebaseFanoutSibling`

**Files:**
- Modify: `src/metrics/service.ts`, `src/metrics/collectors.ts`
- Test: `test/metrics/service.test.ts` (extend)

- [ ] **Step 1: Tests**

```typescript
describe('fan-out metrics', () => {
  it('increments night_orch_rebase_fanouts_total with repo and base_branch labels', async () => {
    const svc = createMetricsService({ enabled: true, host: '127.0.0.1', port: 0 })
    svc.incRebaseFanout('owner/r', 'develop')
    const text = await svc.getRegistry().metrics()
    expect(text).toMatch(/night_orch_rebase_fanouts_total\{[^}]*repo="owner\/r"[^}]*base_branch="develop"[^}]*\}\s+1/)
  })

  it('increments siblings counter independently per call', async () => {
    const svc = createMetricsService({ enabled: true, host: '127.0.0.1', port: 0 })
    svc.incRebaseFanoutSibling('owner/r')
    svc.incRebaseFanoutSibling('owner/r')
    const text = await svc.getRegistry().metrics()
    expect(text).toMatch(/night_orch_rebase_fanout_siblings_queued_total\{[^}]*repo="owner\/r"[^}]*\}\s+2/)
  })
})
```

- [ ] **Step 2: Implement**

In `src/metrics/service.ts`, extend `MetricsService` interface, `NoopMetricsService`, and `LiveMetricsService` with `incRebaseFanout(repo, baseBranch)` and `incRebaseFanoutSibling(repo)`. In `src/metrics/collectors.ts`, register the two new `Counter` instances exactly as listed in the previous plan version (kept verbatim — names: `night_orch_rebase_fanouts_total` with `['repo', 'base_branch']` labels, and `night_orch_rebase_fanout_siblings_queued_total` with `['repo']`).

- [ ] **Step 3: Verify + commit**

```bash
pnpm test -- --run test/metrics/
pnpm typecheck
git add src/metrics/ test/metrics/
git commit -m "[FEATURE] Add fan-out metrics counters"
```

---

## Task 11: Retention — prune `rebase_fanouts` via `RetentionEngine`

**Files:**
- Modify: `src/ops/retention.ts`
- Test: `test/ops/retention.test.ts` (extend)

`RetentionEngine.prune(options)` exists at `src/ops/retention.ts:30`. Dry-run short-circuits at `:45`. The new pruner must respect that.

- [ ] **Step 1: Tests**

```typescript
import { RetentionEngine } from '../../src/ops/retention.js'
import { RebaseFanoutManager } from '../../src/state/rebase-fanouts.js'
import { initDatabase } from '../../src/state/db.js'

describe('RetentionEngine rebase_fanouts', () => {
  it('prunes rebase_fanouts older than rebaseFanoutsRetentionDays', () => {
    const db = initDatabase(':memory:')
    const fanouts = new RebaseFanoutManager(db)
    fanouts.mark('owner/r', 1, 0)
    db.prepare("UPDATE rebase_fanouts SET fanned_out_at = ? WHERE source_pr_number = 1")
      .run(new Date(Date.now() - 100 * 86400 * 1000).toISOString())
    fanouts.mark('owner/r', 2, 0)
    const result = new RetentionEngine(db).prune({ rebaseFanoutsRetentionDays: 90 })
    expect(result.rebaseFanoutsDeleted).toBe(1)
    expect(fanouts.has('owner/r', 1)).toBe(false)
    expect(fanouts.has('owner/r', 2)).toBe(true)
  })

  it('reports rebaseFanoutsDeleted as dry-run count without deleting', () => {
    const db = initDatabase(':memory:')
    const fanouts = new RebaseFanoutManager(db)
    fanouts.mark('owner/r', 1, 0)
    db.prepare("UPDATE rebase_fanouts SET fanned_out_at = ? WHERE source_pr_number = 1")
      .run(new Date(Date.now() - 100 * 86400 * 1000).toISOString())
    const result = new RetentionEngine(db).prune({ rebaseFanoutsRetentionDays: 90, dryRun: true })
    expect(result.rebaseFanoutsDeleted).toBe(1)
    expect(fanouts.has('owner/r', 1)).toBe(true)
  })

  it('defaults to 90 days when rebaseFanoutsRetentionDays is omitted', () => {
    const db = initDatabase(':memory:')
    const fanouts = new RebaseFanoutManager(db)
    fanouts.mark('owner/r', 1, 0)
    db.prepare("UPDATE rebase_fanouts SET fanned_out_at = ? WHERE source_pr_number = 1")
      .run(new Date(Date.now() - 100 * 86400 * 1000).toISOString())
    const result = new RetentionEngine(db).prune({})
    expect(result.rebaseFanoutsDeleted).toBe(1)
  })
})
```

- [ ] **Step 2: Extend `RetentionEngine.prune`**

In `src/ops/retention.ts`:
- Add `rebaseFanoutsRetentionDays?: number` to `RetentionOptions` (default `90` inside `prune`).
- Add `rebaseFanoutsDeleted: number` to `RetentionResult`.
- Inside `prune(options)`, regardless of the existing dry-run short-circuit, route the rebase-fanouts pass through `RebaseFanoutManager.pruneOlderThan(days, { dryRun: options.dryRun ?? false })` and include the count in the returned result. If the existing short-circuit returns early before reaching the new code, refactor so the dry-run path still computes counts via the manager's `dryRun` option for every retention bucket (matching what's already done for other tables, or — if other buckets don't report dry-run counts — at minimum report the count for fan-outs).

- [ ] **Step 3: Verify + commit**

```bash
pnpm test -- --run test/ops/retention.test.ts
pnpm typecheck
git add src/ops/retention.ts test/ops/retention.test.ts
git commit -m "[FEATURE] Prune rebase_fanouts table in RetentionEngine"
```

---

## Task 12: Documentation

**Files:**
- Modify: `docs/CONFIGURATION.md`, `docs/OVERVIEW.md`, `docs/USAGE.md`, `examples/config.example.yaml`

- [ ] **Step 1: `docs/CONFIGURATION.md`**

Add a new subsection under the repository configuration reference titled **"`autoRebaseOnMerge` — automatic rebase fan-out"**:

```markdown
### `autoRebaseOnMerge`

When a tracked PR merges into its base branch, night-orch automatically queues a rebase attempt for every other open sibling PR in the same repo whose base branch matches the just-merged PR. This keeps sibling branches up to date without manual `night-orch rebase` invocations.

| Field            | Type                  | Default                                 | Description |
|------------------|-----------------------|-----------------------------------------|-------------|
| `enabled`        | `boolean`             | `false`                                 | Opt-in switch. |
| `maxFanout`      | `integer (1..200)`    | `20`                                    | Hard cap on siblings queued per merge event. |
| `strategy`       | `'rebase' \| 'merge'` | `'rebase'`                              | How the worktree picks up upstream changes. |
| `maxChainLength` | `integer (1..100)`    | `2 × loop.maxAttemptChainLength`        | Per-sibling attempt-chain cap for fan-out attempts. |

Example:

\`\`\`yaml
repos:
  - repo: owner/repo
    localPath: ~/code/repo
    baseBranch: develop
    autoRebaseOnMerge:
      enabled: true
      maxFanout: 10
      strategy: rebase
\`\`\`

Sibling filter (applied in order):
1. Tracked in `runs`, top-level (no `parent_run_id`), non-terminated.
2. Status in `{review_ready, blocked, error}`.
3. No in-flight rebase attempt for the issue.
4. Forge confirms PR `state === 'open'` and `baseBranch` matches the merged PR's base.

Idempotent across daemon restarts via the `rebase_fanouts` table; rows are pruned after 90 days by retention.
```

Add `labels.rebasing` to the labels reference table:

```markdown
| `labels.rebasing` | `string` | _(unset — falls back to `labels.running`)_ | Optional distinct label applied while a run is executing with `operationIntent === 'rebase'`, including fan-out rebases. |
```

- [ ] **Step 2: `docs/OVERVIEW.md`**

```markdown
**Merge fan-out**: when a PR merges into its base branch, the next poll cycle queues a rebase attempt for every open sibling PR on the same base. The poller rebases each branch, runs verify, and only triggers a full code → verify → review cycle if verify fails. This keeps long-lived sibling PRs current without manual intervention.
```

- [ ] **Step 3: `docs/USAGE.md`**

Document the auto-behavior under "Lifecycle automation" (or equivalent), including how to disable (`autoRebaseOnMerge.enabled: false`).

- [ ] **Step 4: `examples/config.example.yaml`**

Under the repo block:

```yaml
    # Auto-rebase fan-out: queue rebase for sibling PRs after merges.
    # autoRebaseOnMerge:
    #   enabled: false
    #   maxFanout: 20
    #   strategy: rebase
    #   maxChainLength: 12
```

Under `labels:`:

```yaml
    # rebasing: no:rebasing   # optional distinct label during rebase attempts
```

- [ ] **Step 5: Build + commit**

```bash
pnpm docs:build
git add docs/ examples/config.example.yaml
git commit -m "[DOCS] Document autoRebaseOnMerge config and labels.rebasing"
```

---

## Task 13: Integration sweep + CHANGELOG

- [ ] **Step 1: Full check**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 2: CHANGELOG (if present)**

```markdown
### Added
- Auto-rebase fan-out: merging a tracked PR now queues rebase attempts for sibling PRs on the same base branch. Per-repo opt-in via `autoRebaseOnMerge.enabled` (default `false`). New optional `labels.rebasing` field provides a distinct visual signal while a run rebases.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "[DOCS] Note auto-rebase fan-out in changelog"
```

---

## Verification checklist (before declaring done)

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` all suites green
- [ ] `pnpm docs:build` succeeds
- [ ] Migration runs forward on a copy of a production DB (`night-orch doctor` against a real config)
- [ ] Manual smoke: merge a tracked PR in a test repo with `autoRebaseOnMerge.enabled: true`; observe siblings transitioning `queued → running` carrying the `rebasing` label; verify the bot comment on each sibling references the source PR number and base branch; verify the `rebase_fanouts` row exists after the loop completes; verify exhausting the chain on a known-divergent sibling posts the "manual review needed" comment.
- [ ] Disabling via `autoRebaseOnMerge.enabled: false` (or omitting the block) preserves previous behaviour exactly — no fan-out, no new labels, no extra DB writes beyond migration.

---

## Notes for the implementing engineer

- **Cross-cutting types**: `RunStatus`, `RunOperationIntent`, and `RunRecord` are exported from `src/state/runs.ts`. `LabelConfig` and `LabelIntent` from `src/labels/transitions.ts`. Import from the existing modules — never redeclare.
- **`noUncheckedIndexedAccess`**: indexed access on `mock.calls`, arrays, and `Object.fromEntries` results yields `T | undefined`. Use `!` only where you've explicitly guarded length first.
- **`execa` for git**: the fan-out code itself does no git — it only queues; `executeRebase` already owns the git side.
- **Forge calls**: stay inside `forge/github.ts` and `forge/forgejo.ts` adapters. The orchestrator consumes `ForgeAdapter` methods only; never import `@octokit/rest` from `ops/fanout-rebase.ts`.
- **Security**: no new env vars are read or passed to workers. Tokens never enter the fan-out code.
- **ESM imports**: every relative import uses the `.js` suffix even when the source is `.ts`. Every Node builtin uses the `node:` prefix.
- **If a step's claim about a file or column doesn't match what you see**, stop and update the plan. The verified-facts list at the top is authoritative — anything contradicting it should be flagged before changing code.
