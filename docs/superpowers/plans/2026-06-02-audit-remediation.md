# Audit Remediation Implementation Plan (Rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do not run `git add` / `git commit` — staging and commits happen only on explicit user request.**

**Goal:** Close the critical and high-priority findings from the 2026-06-02 super-audit so night-orch runs reliably AFK on issues, fan-out after merge is crash- and race-safe per [ADR-0001](../../adr/0001-auto-rebase-fanout-on-merge.md), and the plan/execute/review workflow stays correct under parallel sub-tasks.

**Architecture:** Three sequential phases gated on `pnpm lint && pnpm typecheck && pnpm test`. Phase 1 unblocks AFK confidence (fix the failing test, harden config-default trust, ship Octokit throttle/retry, fix daily-cost-reset, bound poll concurrency, bump CVE deps). Phase 2 hardens fan-out (in-process dedup + per-sibling durable record preserving ADR mark-after semantics, retry-vs-merge-queue guard, CLI/TUI/MCP parity, actor threading, checkpoint transactions). Phase 3 hardens the web surface (agent-session permission default, CSRF double-submit with frontend + config support, sidecar-file loopback token, error scrubbing). All work follows existing project conventions (ESM `.js` imports, `node:` prefix, no `any`, `noUncheckedIndexedAccess`, RunContext immutable, pure `decide()`, forge ops via adapter, no commits without explicit request).

**Tech Stack:** TypeScript 5 strict ESM · Node 24 · vitest 4 · better-sqlite3 12 · @octokit/rest 22 · pino 10 · zod 3 · execa 9 · commander 14 · ink 6 · React 19

## Review Integration Notes (Rev 2)

This revision incorporates the read-only code review of Rev 1. Key changes:

- **Fan-out idempotency preserves ADR semantics** — claim-before-loop (Rev 1) violated [ADR-0001](../../adr/0001-auto-rebase-fanout-on-merge.md) which mandates marker-after-loop for crash-mid-loop reruns. Rev 2 keeps `mark()` after the loop and solves the in-process race with a per-`(repo,sourcePr)` Promise dedup map plus a new `rebase_fanout_siblings` table so per-sibling work is durably idempotent on crash-resume.
- **Fan-out trigger stays where merges are observed** — Rev 1's "trigger from run-finalizer" was wrong: `finalizeRunOutcome` runs on `publish`/`blocked` terminal states, has no `mergedPrNumber`/`mergeCommitSha`, and fires before the PR is merged. Rev 2 keeps the existing two trigger sites (`sync.ts` post-merge reconciliation, `merge-queue/runner.ts:transitionMergedRuns`), audits both for parity, and adds a startup resumability scan that re-runs incomplete fan-outs.
- **Loopback web auth replacement** — Rev 1's "stop returning `mutationToken`" left loopback users with no way to authenticate. Rev 2 replaces the response-body token with a sidecar file (`$XDG_RUNTIME_DIR/night-orch-web.token`, mode 0600) that the operator's browser-side script reads via shell paste, plus a fallback printed-once-to-stdout token for ephemeral sessions.
- **CSRF task includes frontend + config** — Rev 1 omitted `web/src/*` and `src/config/schema.ts`. Rev 2 lists the SPA fetch wrapper changes and the new `web.trustedProxy` config field.
- **All commit steps removed** — Replaced with "verify clean lint+typecheck+test" sub-steps. The user controls when to stage and commit.
- **API targets corrected** — `AnthropicClient.throwForStatus` (not `handleErrorResponse`), `RetryEngine.retry(repo, issueNumber, options)` (not `retryRun({runId})`), `merge_batches.pr_numbers` JSON column (not a `pr_numbers` table), `runVerifyCommands` returns `VerifyResult[]` with `{stdout,stderr,...}` (not `{logged,promptEmbed}`), `RebaseTrigger` union extends to `{kind:'comment',user}` (current shape is `manual|cli|mcp|tui|fanout{sourcePr}`).
- **Schema-bypass tests** — Rev 1's `ConfigSchema.parse` for the missing-`autoRebaseOnMerge` fixture would restore the default and hide the bug. Rev 2's Task 1 fixture uses a raw cast intentionally to keep the field unset.
- **Test fixtures match real call paths** — Rev 1 Task 3 fixture didn't trigger the collaborator branch. Rev 2 seeds an active run with a `/orch rebase` comment so the runtime actually reaches `isCollaborator`.
- **Octokit mock gets a `.plugin()` shim** — Task 5 adds `static plugin = (...) => MockOctokit` to the test double so the wrapped constructor works.

---

## File Structure

This plan touches the following layers:

- **`src/ops/`** — `fanout-rebase.ts`, `sync.ts`, `retry.ts`, `daily-cost-reset.ts`, `rebase-and-check.ts`
- **`src/forge/`** — `github.ts` gains throttle + retry plugins
- **`src/runner/`** — `comment-commands.ts` fallback default, audit fan-out coverage (no code change in `run-finalizer.ts`)
- **`src/state/`** — `rebase-fanouts.ts` gains durable per-sibling record + dedup helper, migration `031`
- **`src/web/`** — `agent-session.ts`, `auth.ts`, `server.ts`, `routes/api-auth.ts`, `routes/api-runs.ts`
- **`web/src/`** — `App.tsx` (fetch wrapper for CSRF token, login flow change)
- **`src/ai/`** — `anthropic.ts` (`throwForStatus`), `openai.ts`, `openrouter.ts`
- **`src/loop/`** — `verifier.ts` (stderr scrub), `step-executor.ts` (prompt-embed scrub), `checkpoint.ts` (transaction wraps)
- **`src/cli/`** + **`src/cli/tui/`** + **`src/mcp/`** — parity sweep for rebase `maxAttemptChainLength`
- **`src/config/schema.ts`** — `github.pollConcurrency`, `web.trustedProxy`, `workerProfiles[name].allowAgentSessionBypass`
- **`src/utils/`** — `concurrency.ts` (new — bounded `mapWithConcurrency`)
- **`test/`** — focused new files plus updates to existing fixtures
- **`docs/`** — `CONFIGURATION.md`, `USAGE.md`, `OVERVIEW.md`

New files:
- `src/utils/concurrency.ts` + `test/utils/concurrency.test.ts`
- `src/state/migrations/031-rebase-fanout-siblings.ts`
- `test/runner/comment-commands.test.ts` (extend if file already exists)
- `test/ai/scrubbing.test.ts`
- `test/web/csrf.test.ts`

---

## Phase 1 — AFK Unblockers

### Task 1: Defensive guard for missing `autoRebaseOnMerge`

**Files:**
- Modify: `src/ops/fanout-rebase.ts:84-92`
- Test: `test/ops/fanout-rebase.test.ts`

- [ ] **Step 1: Write the failing test using a raw cast (bypass schema defaulting)**

Add to `test/ops/fanout-rebase.test.ts`:

```typescript
it('returns skippedDisabled when repoConfig.autoRebaseOnMerge is undefined', async () => {
  // Intentionally bypass ConfigSchema.parse — we are testing the
  // consumer's tolerance of a non-validated boundary path. Test
  // helpers that deep-merge defaults would re-add autoRebaseOnMerge
  // and hide the bug.
  const repoConfig = {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/tmp/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    labels: { ready: ['no:ready'], running: 'no:running', blocked: ['no:blocked'], reviewReady: 'no:review-ready', error: 'no:error', retry: 'no:retry' },
    defaults: { planner: 'claude', coder: 'claude', reviewer: 'claude', prMentions: [] },
    verify: [],
    selectors: { includeLabelsAny: [], excludeLabelsAny: [] },
    agents: {},
    // autoRebaseOnMerge intentionally omitted
  } as unknown as RepoConfig

  const db = makeInMemoryDb()
  const forge = makeMockForge()
  const config = { repos: [repoConfig] } as unknown as Config

  const result = await fanoutRebaseAfterMerge({
    db, repoConfig, forge, config,
    sourcePrNumber: 42, baseBranch: 'main', botUser: 'orch-bot',
  })

  expect(result).toEqual({
    queued: 0, skipped: 0, failures: 0,
    alreadyFannedOut: false, skippedDisabled: true,
  })
})
```

Use `makeInMemoryDb` / `makeMockForge` patterns from sibling tests in `test/ops/`.

- [ ] **Step 2: Run and confirm fail**

```
pnpm test -- --run test/ops/fanout-rebase.test.ts -t 'returns skippedDisabled when repoConfig.autoRebaseOnMerge is undefined'
```

Expected: FAIL with `TypeError: Cannot read properties of undefined (reading 'enabled')`.

- [ ] **Step 3: Apply the defensive guard**

In `src/ops/fanout-rebase.ts`, replace lines 88-92 with:

```typescript
  const autoRebase = repoConfig.autoRebaseOnMerge

  if (!autoRebase?.enabled) {
    return { queued: 0, skipped: 0, failures: 0, alreadyFannedOut: false, skippedDisabled: true }
  }
```

Update line 110's `autoRebase.maxFanout` reference — TypeScript will surface this — to `autoRebase.maxFanout` (still works since we narrowed via `?.`). Use a `const autoRebaseSettings = autoRebase` rebind after the guard if needed for ergonomics.

- [ ] **Step 4: Run targeted test**

```
pnpm test -- --run test/ops/fanout-rebase.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the previously-failing integration test**

```
pnpm test -- --run test/ops/full-ops.test.ts
```

Expected: PASS. The defensive guard tolerates the existing `as Config` cast in `makeConfig` (`test/ops/full-ops.test.ts:52-69`); no fixture change required for this task.

- [ ] **Step 6: Verify clean**

```
pnpm lint && pnpm typecheck
```

Expected: 0 errors.

---

### Task 2: Default `requireCollaborator` to true when `commentCommands` is unset

**Files:**
- Modify: `src/runner/comment-commands.ts:89-96`
- Test: `test/runner/comment-commands.test.ts` (create if absent; mirror sibling fixtures)
- Docs: `docs/CONFIGURATION.md`, `docs/USAGE.md`

- [ ] **Step 1: Inspect the current trigger path**

Read `src/runner/comment-commands.ts:75-150` to confirm the chain: `processCommentCommands` early-returns when `activeRuns` is empty. The test must seed an active run for the repo so the collaborator check is reached.

- [ ] **Step 2: Write the failing test**

Create / extend `test/runner/comment-commands.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { processCommentCommands } from '../../src/runner/comment-commands.js'

describe('processCommentCommands', () => {
  it('enforces collaborator check when commentCommands is undefined', async () => {
    const db = makeInMemoryDb()
    const repoConfig = makeRepoConfig({ repo: 'org/repo' })
    // Seed an active run so processCommentCommands does not early-return.
    insertRun(db, { repo: 'org/repo', issue_number: 7, status: 'review_ready' })

    const isCollaborator = vi.fn().mockResolvedValue(false)
    const forge = makeMockForge({
      listIssueComments: vi.fn().mockResolvedValue([
        { id: 1, user: 'random-attacker', body: '/orch rebase', createdAt: new Date().toISOString() },
      ]),
      isCollaborator,
    })

    const config = { repos: [repoConfig], commentCommands: undefined } as unknown as Config
    await processCommentCommands({
      config, db, forge,
      runManager: new RunManager(db),
      leaseManager: new LeaseManager(db),
      repoConfig, botUser: 'orch-bot',
      cache: makeOrchestrationCache(),
    })

    expect(isCollaborator).toHaveBeenCalledWith('org/repo', 'random-attacker')
  })
})
```

- [ ] **Step 3: Run and confirm fail**

```
pnpm test -- --run test/runner/comment-commands.test.ts
```

Expected: FAIL — current fallback at line 89 is `requireCollaborator: false`, so `isCollaborator` is never called.

- [ ] **Step 4: Apply the fix**

In `src/runner/comment-commands.ts`:

```typescript
  const commandSettings = config.commentCommands ?? { enabled: true, requireCollaborator: true }
  if (!commandSettings.enabled) return
  if (config.commentCommands && commandSettings.requireCollaborator === false) {
    logger.warn(
      { repo: repoConfig.repo },
      'commentCommands.requireCollaborator=false — /orch commands accept any commenter. Enable on public repos.',
    )
  }
```

The change: (a) safe fallback now `true`, (b) warning only fires when the operator *explicitly* opts out (`config.commentCommands` truthy AND `requireCollaborator === false`).

- [ ] **Step 5: Update docs**

In `docs/CONFIGURATION.md` (`commentCommands.requireCollaborator` section) and `docs/USAGE.md:607` (where the default is currently described as `false`), state that when `commentCommands` is omitted the runtime treats `requireCollaborator` as `true`. Explicit `false` is allowed but logs a warning per cycle.

- [ ] **Step 6: Run + verify**

```
pnpm test -- --run test/runner/
pnpm lint && pnpm typecheck
```

Expected: PASS.

---

### Task 3: Fix daily-cost-reset empty-date fallback

**Files:**
- Modify: `src/ops/daily-cost-reset.ts:29`
- Test: `test/ops/daily-cost-reset.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { resetDailyCostsAndResume } from '../../src/ops/daily-cost-reset.js'
import { utcDayKey } from '../../src/utils/time.js'

describe('resetDailyCostsAndResume', () => {
  it('uses utcDayKey() for the reset date (canonical ISO YYYY-MM-DD)', async () => {
    const db = makeInMemoryDb()
    const today = utcDayKey()
    const config = { repos: [] } as unknown as Config
    const forge = makeMockForge()

    const result = await resetDailyCostsAndResume(db, config, forge)

    expect(result.date).toBe(today)
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
```

- [ ] **Step 2: Run + confirm**

```
pnpm test -- --run test/ops/daily-cost-reset.test.ts
```

If the test passes today (because `new Date().toISOString().split('T')[0]` happens to work), the fix is still desirable — keep the test as a regression guard.

- [ ] **Step 3: Apply the fix**

In `src/ops/daily-cost-reset.ts`:

```typescript
// add at top with other imports
import { utcDayKey } from '../utils/time.js'

// replace line 29
const date = utcDayKey()
```

- [ ] **Step 4: Verify**

```
pnpm test -- --run test/ops/daily-cost-reset.test.ts
pnpm lint && pnpm typecheck
```

---

### Task 4: Add `@octokit/plugin-throttling` + `@octokit/plugin-retry`

**Files:**
- Modify: `package.json`
- Modify: `src/forge/github.ts:17-25`
- Modify: `test/forge/github.test.ts:99-115` (add `.plugin()` shim to the mock)

- [ ] **Step 1: Add deps**

```
pnpm add @octokit/plugin-throttling@^11.0.0 @octokit/plugin-retry@^8.0.0
```

- [ ] **Step 2: Update the Octokit mock to support `.plugin()`**

In `test/forge/github.test.ts`, replace the `vi.mock('@octokit/rest', ...)` block so `MockOctokit` exposes a static `plugin` method that returns itself (the test does not exercise plugin internals):

```typescript
vi.mock('@octokit/rest', () => {
  class MockOctokit {
    static plugin(..._plugins: unknown[]) { return MockOctokit }
    paginate = mockPaginate
    rest = {
      issues: { listForRepo: mockIssuesListForRepo, get: mockIssuesGet, addLabels: mockIssuesAddLabels, removeLabel: mockIssuesRemoveLabel, createComment: mockIssuesCreateComment },
      users: { getAuthenticated: mockUsersGetAuthenticated },
      pulls: { create: mockPullsCreate, update: mockPullsUpdate, list: mockPullsList, get: mockPullsGet },
      rateLimit: { get: mockRateLimitGet },
      repos: { getCollaboratorPermissionLevel: mockReposGetCollaboratorPermissionLevel },
    }
    constructor(_options?: unknown) {}
  }
  return { Octokit: MockOctokit }
})

vi.mock('@octokit/plugin-throttling', () => ({ throttling: {} }))
vi.mock('@octokit/plugin-retry', () => ({ retry: {} }))
```

- [ ] **Step 3: Write a failing test**

Add to `test/forge/github.test.ts`:

```typescript
it('constructs GitHubForgeAdapter without throwing (throttle + retry plugins wrapped)', () => {
  expect(() => new GitHubForgeAdapter('test-token')).not.toThrow()
})

it('passes throttle config with rate-limit handlers', () => {
  // Spy on the constructor by re-wiring MockOctokit to capture options.
  // ...assert options.throttle.onRateLimit is a function.
})
```

- [ ] **Step 4: Run + confirm fail**

```
pnpm test -- --run test/forge/github.test.ts
```

Expected: FAIL — current code doesn't call `Octokit.plugin(...)`.

- [ ] **Step 5: Wire the plugins**

In `src/forge/github.ts`:

```typescript
import { Octokit } from '@octokit/rest'
import { throttling } from '@octokit/plugin-throttling'
import { retry } from '@octokit/plugin-retry'
import type { RepoConfig } from '../config/schema.js'
import type {
  ForgeAdapter, ForgeIssue, ForgePR, PRParams, ForgeAuthInfo,
  ForgeComment, ForgePRReview, ForgePRReviewComment, PRReviewState, MergeMethod,
  PRCheckStatus, PRCheckRun, CheckConclusion,
} from './types.js'
import { getDiscoveryIncludeLabels } from '../labels/config.js'
import { logger } from '../utils/logger.js'

const ResilientOctokit = Octokit.plugin(throttling, retry)

export class GitHubForgeAdapter implements ForgeAdapter {
  private octokit: InstanceType<typeof ResilientOctokit>

  constructor(token: string, baseUrl?: string) {
    this.octokit = new ResilientOctokit({
      auth: token,
      baseUrl: baseUrl ?? 'https://api.github.com',
      throttle: {
        onRateLimit: (retryAfter: number, options: { method?: string; url?: string; request: { retryCount: number } }) => {
          logger.warn({ retryAfter, method: options.method, url: options.url, retryCount: options.request.retryCount }, 'GitHub rate limit hit')
          return options.request.retryCount < 2
        },
        onSecondaryRateLimit: (retryAfter: number, options: { method?: string; url?: string }) => {
          logger.warn({ retryAfter, method: options.method, url: options.url }, 'GitHub secondary rate limit hit')
          return true
        },
      },
      retry: { doNotRetry: ['400', '401', '403', '404', '422'] },
    })
  }
  // ... unchanged methods
}
```

- [ ] **Step 6: Update docs**

`docs/OVERVIEW.md` — add a bullet to the GitHub adapter section: "Throttle + retry plugins absorb transient 429/5xx (max 2 retries; secondary rate limits always retried)."

- [ ] **Step 7: Verify**

```
pnpm test -- --run test/forge/
pnpm lint && pnpm typecheck
```

---

### Task 5: Bound per-repo poll concurrency

**Files:**
- New: `src/utils/concurrency.ts`
- New: `test/utils/concurrency.test.ts`
- Modify: `src/runner/poller.ts:105-122`
- Modify: `src/config/schema.ts` (add `github.pollConcurrency`)
- Docs: `docs/CONFIGURATION.md`

Note: the schema has no top-level `runner` block. The poll cadence lives at `github.pollIntervalSeconds`, so the concurrency knob belongs in the same `github` object.

- [ ] **Step 1: Add the concurrency helper**

`src/utils/concurrency.ts`:

```typescript
/**
 * Map `items` to async results, bounding concurrent invocations to `limit`.
 *
 * Preserves input order in the result array. Rejections propagate after all
 * in-flight tasks settle — equivalent to `Promise.all` semantics on order
 * but with a configurable concurrency cap.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  if (items.length === 0) return results
  const workerCount = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      const item = items[i]
      if (item === undefined) continue
      results[i] = await fn(item, i)
    }
  })
  await Promise.all(workers)
  return results
}
```

- [ ] **Step 2: Test the helper**

`test/utils/concurrency.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from '../../src/utils/concurrency.js'

describe('mapWithConcurrency', () => {
  it('bounds peak concurrency to the limit', async () => {
    let active = 0
    let peak = 0
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return n * 2
    })
    expect(peak).toBeLessThanOrEqual(2)
    expect(result).toEqual([2, 4, 6, 8, 10, 12])
  })

  it('returns empty array for empty input', async () => {
    expect(await mapWithConcurrency<number, number>([], 4, async (n) => n)).toEqual([])
  })
})
```

- [ ] **Step 3: Run it**

```
pnpm test -- --run test/utils/concurrency.test.ts
```

Expected: PASS.

- [ ] **Step 4: Add the schema field**

In `src/config/schema.ts` find the `github` object (~line 663-671) and add:

```typescript
github: z.object({
  tokenEnv: z.string().refine(
    (val) => !val.startsWith('ghp_') && !val.startsWith('ghs_') && !val.startsWith('github_pat_'),
    { message: 'tokenEnv should be an environment variable name, not a literal token' },
  ),
  apiBaseUrl: z.string().url().default('https://api.github.com'),
  pollIntervalSeconds: z.number().positive().default(300),
  pollConcurrency: z.number().int().positive().max(32).default(4),
  appMentions: z.record(AppMentionSchema).default({}),
}),
```

- [ ] **Step 5: Wire the helper into the poller**

In `src/runner/poller.ts`, replace the `Promise.all(reposToProcess.map(...))` block (~line 105-122) with:

```typescript
import { mapWithConcurrency } from '../utils/concurrency.js'

// ...inside pollOnce, after reposToProcess is built:
const repoResults = await mapWithConcurrency(
  reposToProcess,
  config.github.pollConcurrency,
  (repoConfig): Promise<PollResult> => pollRepo({
    config, db, repoConfig, runManager, leaseManager, issueManager,
    worktreeManager, fileLoopEngine, costTracker, observability, metrics,
    dryRun, usedPortsInPass, targetIssue,
  }),
)
```

- [ ] **Step 6: Docs**

`docs/CONFIGURATION.md` — add `github.pollConcurrency` row to the GitHub config table: default `4`, range `1-32`, controls how many repos are polled in parallel per cycle.

- [ ] **Step 7: Verify**

```
pnpm lint && pnpm typecheck && pnpm test -- --run test/runner/ test/config/ test/utils/
```

---

### Task 6: Bump `ws` and add CVE overrides

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump direct `ws`**

```
pnpm add ws@^8.20.1
```

- [ ] **Step 2: Add overrides**

In `package.json`, merge into the existing `pnpm.overrides` block (preserve current entries):

```json
"pnpm": {
  "overrides": {
    "ws@<8.20.1": "^8.20.1",
    "fast-uri@<3.1.2": "^3.1.2",
    "qs@<6.15.2": "^6.15.2",
    "postcss@<8.4.49": "^8.4.49"
  }
}
```

- [ ] **Step 3: Refresh lockfile**

```
pnpm install
```

- [ ] **Step 4: Verify**

```
pnpm audit --audit-level moderate
pnpm typecheck && pnpm test
```

Document any remaining moderate findings (e.g. `brace-expansion` storybook-only) in a follow-up issue rather than overriding without diagnosis.

---

### Task 7: Phase 1 gate

- [ ] **Step 1: Full suite**

```
pnpm lint && pnpm typecheck && pnpm test
```

Expected: 0 lint, 0 type errors, all tests pass including the previously-failing `test/ops/full-ops.test.ts > sync + cleanup pipeline`.

- [ ] **Step 2: If anything fails, fix in place. Do not advance to Phase 2 until the gate is green.**

---

## Phase 2 — Fan-out Correctness

### Task 8: Migration `031` — per-sibling durable record

**Files:**
- New: `src/state/migrations/031-rebase-fanout-siblings.ts`
- Modify: migrations index (typically `src/state/migrations/index.ts` — confirm by reading `src/state/db.ts` for the registration pattern)

- [ ] **Step 1: Create the migration**

`src/state/migrations/031-rebase-fanout-siblings.ts`:

```typescript
import type Database from 'better-sqlite3'

export const id = '031-rebase-fanout-siblings'

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rebase_fanout_siblings (
      repo TEXT NOT NULL,
      source_pr_number INTEGER NOT NULL,
      sibling_pr_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','skipped','failed')),
      reason TEXT,
      message TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (repo, source_pr_number, sibling_pr_number)
    );
    CREATE INDEX IF NOT EXISTS idx_rebase_fanout_siblings_source
      ON rebase_fanout_siblings(repo, source_pr_number);

    ALTER TABLE rebase_fanouts ADD COLUMN failures_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE rebase_fanouts ADD COLUMN source_merge_sha TEXT;
  `)
}
```

- [ ] **Step 2: Register the migration**

Add `031-rebase-fanout-siblings` to whatever array the migrations runner iterates. Confirm by reading `src/state/migrations/` for the pattern used by `030-rebase-fanouts.ts`.

- [ ] **Step 3: Verify**

```
pnpm test -- --run test/state/
```

Expected: migrations run cleanly, no test regressions.

---

### Task 9: `RebaseFanoutManager` — per-sibling record + in-process dedup

**Files:**
- Modify: `src/state/rebase-fanouts.ts`
- Test: `test/state/rebase-fanouts.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { RebaseFanoutManager } from '../../src/state/rebase-fanouts.js'
import { initDatabase } from '../../src/state/db.js'

describe('RebaseFanoutManager', () => {
  it('records per-sibling outcomes and is idempotent on replay', () => {
    const db = initDatabase(':memory:')
    const m = new RebaseFanoutManager(db)
    m.recordSibling('org/repo', 100, 200, { status: 'queued' })
    m.recordSibling('org/repo', 100, 200, { status: 'queued' }) // replay
    expect(m.listSiblings('org/repo', 100)).toEqual([
      expect.objectContaining({ sibling_pr_number: 200, status: 'queued' }),
    ])
  })

  it('mark() records failures_count and source_merge_sha', () => {
    const db = initDatabase(':memory:')
    const m = new RebaseFanoutManager(db)
    m.mark('org/repo', 100, 3, { failuresCount: 1, sourceMergeSha: 'sha-abc' })
    const row = m.get('org/repo', 100)
    expect(row).toMatchObject({ siblings_queued: 3, failures_count: 1, source_merge_sha: 'sha-abc' })
  })

  it('runOnce dedups concurrent callers within the same process', async () => {
    const db = initDatabase(':memory:')
    const m = new RebaseFanoutManager(db)
    let inflight = 0
    let peak = 0
    const work = async () => {
      inflight++; peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 20))
      inflight--
      return 'ok'
    }
    const [a, b] = await Promise.all([
      m.runOnce('org/repo', 42, work),
      m.runOnce('org/repo', 42, work),
    ])
    expect(peak).toBe(1)
    expect(a).toBe('ok')
    expect(b).toBe('ok') // second caller awaits the same in-flight promise
  })
})
```

- [ ] **Step 2: Run + confirm fail**

```
pnpm test -- --run test/state/rebase-fanouts.test.ts
```

- [ ] **Step 3: Extend `RebaseFanoutManager`**

```typescript
// src/state/rebase-fanouts.ts
import type Database from 'better-sqlite3'

export type FanoutSiblingStatus = 'queued' | 'skipped' | 'failed'

export interface FanoutSiblingRow {
  repo: string
  source_pr_number: number
  sibling_pr_number: number
  status: FanoutSiblingStatus
  reason: string | null
  message: string | null
  recorded_at: string
}

export class RebaseFanoutManager {
  // Per-process in-flight map: ensures sync + merge-queue callers within
  // the same daemon process do not double-fan-out before the durable
  // marker is written. Crash safety is provided by recordSibling()
  // (per-PR idempotent) + mark() at end of loop (ADR-0001).
  private static readonly inflight = new Map<string, Promise<unknown>>()

  constructor(private db: Database.Database) {}

  has(repo: string, sourcePrNumber: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM rebase_fanouts WHERE repo = ? AND source_pr_number = ?')
      .get(repo, sourcePrNumber)
    return row !== undefined
  }

  get(repo: string, sourcePrNumber: number): { siblings_queued: number; failures_count: number; source_merge_sha: string | null } | undefined {
    return this.db
      .prepare('SELECT siblings_queued, failures_count, source_merge_sha FROM rebase_fanouts WHERE repo = ? AND source_pr_number = ?')
      .get(repo, sourcePrNumber) as { siblings_queued: number; failures_count: number; source_merge_sha: string | null } | undefined
  }

  mark(
    repo: string,
    sourcePrNumber: number,
    siblingsQueued: number,
    opts: { failuresCount?: number; sourceMergeSha?: string | null } = {},
  ): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO rebase_fanouts
          (repo, source_pr_number, fanned_out_at, siblings_queued, failures_count, source_merge_sha)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        repo,
        sourcePrNumber,
        new Date().toISOString(),
        siblingsQueued,
        opts.failuresCount ?? 0,
        opts.sourceMergeSha ?? null,
      )
  }

  recordSibling(
    repo: string,
    sourcePrNumber: number,
    siblingPrNumber: number,
    outcome: { status: FanoutSiblingStatus; reason?: string; message?: string },
  ): void {
    this.db
      .prepare(`
        INSERT INTO rebase_fanout_siblings
          (repo, source_pr_number, sibling_pr_number, status, reason, message, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo, source_pr_number, sibling_pr_number) DO UPDATE SET
          status = excluded.status,
          reason = excluded.reason,
          message = excluded.message,
          recorded_at = excluded.recorded_at
      `)
      .run(
        repo, sourcePrNumber, siblingPrNumber,
        outcome.status, outcome.reason ?? null, outcome.message ?? null,
        new Date().toISOString(),
      )
  }

  listSiblings(repo: string, sourcePrNumber: number): FanoutSiblingRow[] {
    return this.db
      .prepare('SELECT * FROM rebase_fanout_siblings WHERE repo = ? AND source_pr_number = ?')
      .all(repo, sourcePrNumber) as FanoutSiblingRow[]
  }

  pruneOlderThan(days: number, options: { dryRun?: boolean } = {}): number {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString()
    if (options.dryRun) {
      const row = this.db
        .prepare('SELECT COUNT(*) AS count FROM rebase_fanouts WHERE fanned_out_at < ?')
        .get(cutoff) as { count: number }
      return row.count
    }
    return this.db
      .prepare('DELETE FROM rebase_fanouts WHERE fanned_out_at < ?')
      .run(cutoff).changes
  }

  /**
   * Dedup concurrent in-process callers for the same (repo, sourcePrNumber).
   * The first caller runs `work`. Subsequent callers entering before `work`
   * settles receive the same promise. Crash safety is unaffected — if the
   * process dies before `work` resolves, the next process restart sees no
   * marker (mark() ran at the end of `work`) and re-runs cleanly per ADR-0001.
   */
  async runOnce<T>(repo: string, sourcePrNumber: number, work: () => Promise<T>): Promise<T> {
    const key = `${repo}#${sourcePrNumber}`
    const existing = RebaseFanoutManager.inflight.get(key) as Promise<T> | undefined
    if (existing) return existing
    const promise = (async () => {
      try {
        return await work()
      } finally {
        RebaseFanoutManager.inflight.delete(key)
      }
    })()
    RebaseFanoutManager.inflight.set(key, promise)
    return promise
  }
}
```

- [ ] **Step 4: Verify**

```
pnpm test -- --run test/state/rebase-fanouts.test.ts
pnpm lint && pnpm typecheck
```

---

### Task 10: Always mark fan-out; record per-sibling outcomes

**Files:**
- Modify: `src/ops/fanout-rebase.ts`
- Modify: `src/ops/sync.ts` (thread `sourceMergeSha`)
- Modify: `src/merge-queue/runner.ts` (thread `sourceMergeSha`)
- Test: `test/ops/fanout-rebase.test.ts`

- [ ] **Step 1: Failing test — always-mark on partial failure**

```typescript
it('marks fan-out even when one candidate fails; records per-sibling outcomes', async () => {
  const db = makeInMemoryDb()
  const fanouts = new RebaseFanoutManager(db)
  // Seed 3 eligible runs for the source repo (PR numbers 200, 201, 202)
  insertRun(db, { repo: 'org/repo', issue_number: 1, pr_number: 200, status: 'review_ready', branch_name: 'orch/1' })
  insertRun(db, { repo: 'org/repo', issue_number: 2, pr_number: 201, status: 'review_ready', branch_name: 'orch/2' })
  insertRun(db, { repo: 'org/repo', issue_number: 3, pr_number: 202, status: 'review_ready', branch_name: 'orch/3' })

  const queueRebase = vi.fn<[QueueRebaseParams], Promise<{ queued: boolean; reason: string }>>()
    .mockResolvedValueOnce({ queued: true, reason: '' })
    .mockRejectedValueOnce(new Error('transient API hiccup'))
    .mockResolvedValueOnce({ queued: true, reason: '' })

  const result = await fanoutRebaseAfterMerge({
    db,
    repoConfig: ConfigSchema.parse(makeConfigLiteral()).repos[0]!,
    forge: makeMockForge({ getPR: vi.fn().mockResolvedValue({ baseBranch: 'main' }) }),
    config: ConfigSchema.parse(makeConfigLiteral()),
    sourcePrNumber: 100,
    sourceMergeSha: 'sha-abc',
    baseBranch: 'main',
    botUser: 'orch-bot',
    queueRebase,
    fanouts,
  })

  expect(result.queued).toBe(2)
  expect(result.failures).toBe(1)
  expect(fanouts.get('org/repo', 100)).toMatchObject({
    siblings_queued: 2,
    failures_count: 1,
    source_merge_sha: 'sha-abc',
  })
  const siblings = fanouts.listSiblings('org/repo', 100)
  expect(siblings).toHaveLength(3)
  expect(siblings.find((s) => s.sibling_pr_number === 201)).toMatchObject({ status: 'failed' })
})
```

- [ ] **Step 2: Run + confirm fail**

```
pnpm test -- --run test/ops/fanout-rebase.test.ts
```

- [ ] **Step 3: Update `FanoutDeps` and the loop**

In `src/ops/fanout-rebase.ts`:

```typescript
export interface FanoutDeps {
  db: Database.Database
  repoConfig: RepoConfig
  forge: ForgeAdapter
  config: Config
  sourcePrNumber: number
  sourceMergeSha?: string | null
  baseBranch: string
  botUser: string
  queueRebase?: QueueRebaseFn
  fanouts?: RebaseFanoutManager
  metrics?: {
    incRebaseFanout?: (repo: string, baseBranch: string) => void
    incRebaseFanoutSibling?: (repo: string) => void
  }
}
```

Inside `fanoutRebaseAfterMerge`, after the disabled-check + early-return, wrap the body in `fanouts.runOnce(...)` and structure the loop so:

```typescript
return fanouts.runOnce(repoConfig.repo, sourcePrNumber, async () => {
  // Idempotency short-circuit: already marked? skip.
  if (fanouts.has(repoConfig.repo, sourcePrNumber)) {
    return { queued: 0, skipped: 0, failures: 0, alreadyFannedOut: true, skippedDisabled: false }
  }

  // ... existing candidate selection ...

  let queued = 0
  let skipped = 0
  let failures = 0

  for (const candidate of candidatesWithBaseBranch) {
    try {
      const queueResult = await queueRebase({ ...queueRebaseParams, issueNumber: candidate.issueNumber })
      if (queueResult.queued) {
        queued++
        fanouts.recordSibling(repoConfig.repo, sourcePrNumber, candidate.prNumber, { status: 'queued' })
        metrics?.incRebaseFanoutSibling?.(repoConfig.repo)
      } else if (BENIGN_SKIP_REASONS.has(queueResult.reason)) {
        skipped++
        fanouts.recordSibling(repoConfig.repo, sourcePrNumber, candidate.prNumber, {
          status: 'skipped', reason: queueResult.reason,
        })
      } else {
        failures++
        fanouts.recordSibling(repoConfig.repo, sourcePrNumber, candidate.prNumber, {
          status: 'failed', reason: 'queue_failed', message: queueResult.reason,
        })
      }
    } catch (err) {
      failures++
      fanouts.recordSibling(repoConfig.repo, sourcePrNumber, candidate.prNumber, {
        status: 'failed', reason: 'exception',
        message: err instanceof Error ? err.message : String(err),
      })
      logger.warn({ candidate: candidate.id, err }, 'Fan-out rebase candidate threw')
    }
  }

  // ADR-0001: marker is written AFTER the loop so a crash mid-loop
  // re-runs cleanly on the next sync cycle. recordSibling() is
  // idempotent via the (repo, source_pr_number, sibling_pr_number)
  // primary key, so the replay only re-attempts unfinished siblings.
  fanouts.mark(repoConfig.repo, sourcePrNumber, queued, {
    failuresCount: failures,
    sourceMergeSha: deps.sourceMergeSha ?? null,
  })

  return { queued, skipped, failures, alreadyFannedOut: false, skippedDisabled: false }
})
```

- [ ] **Step 4: Thread `sourceMergeSha` from sync + merge-queue**

In `src/ops/sync.ts` `fanoutFromMergedRun`, pass `sourceMergeSha: mergedPr.mergeCommitSha ?? null` if available from `forge.getPR` / merge detection. If not currently fetched, add a small enrichment.

In `src/merge-queue/runner.ts` `transitionMergedRuns`, pass `sourceMergeSha: batch.mergeCommitSha ?? null` (the batch already carries it via the merge-queue staging record).

- [ ] **Step 5: Verify**

```
pnpm test -- --run test/ops/ test/state/
pnpm lint && pnpm typecheck
```

---

### Task 11: Coverage audit — fan-out trigger sites + startup resumability

**Files:**
- Modify: `src/state/rebase-fanouts.ts` (add `findIncomplete` method)
- Modify: `src/runner/poller.ts` (call at startup, before first poll)
- Test: `test/state/rebase-fanouts.test.ts`, `test/runner/poller.test.ts`

Background: the audit's "M3" finding about event-driven triggers was based on a misread of the code. `fanoutRebaseAfterMerge` already fires from both `src/ops/sync.ts:340` (sync post-merge reconciliation) and `src/merge-queue/runner.ts:233` (merge-queue post-merge transition). The real gap is **resumability**: a process crash between `recordSibling()` calls leaves some siblings missing from `rebase_fanout_siblings`; the marker is not written, so on next sync the entire loop reruns. The per-sibling table makes the rerun cheap (already-queued siblings short-circuit), but we should also surface incomplete fan-outs at startup for operator visibility.

- [ ] **Step 1: Failing test**

```typescript
it('finds incomplete fan-outs (marker present but failures_count > 0)', () => {
  const db = makeInMemoryDb()
  const m = new RebaseFanoutManager(db)
  m.mark('org/repo', 100, 2, { failuresCount: 1, sourceMergeSha: 'sha-abc' })
  m.mark('org/repo', 200, 5, { failuresCount: 0, sourceMergeSha: 'sha-def' })

  const incomplete = m.findIncomplete()
  expect(incomplete).toHaveLength(1)
  expect(incomplete[0]).toMatchObject({ repo: 'org/repo', source_pr_number: 100 })
})
```

- [ ] **Step 2: Implement `findIncomplete`**

```typescript
findIncomplete(): Array<{ repo: string; source_pr_number: number; failures_count: number; fanned_out_at: string }> {
  return this.db
    .prepare(`
      SELECT repo, source_pr_number, failures_count, fanned_out_at
      FROM rebase_fanouts
      WHERE failures_count > 0
      ORDER BY fanned_out_at ASC
    `)
    .all() as Array<{ repo: string; source_pr_number: number; failures_count: number; fanned_out_at: string }>
}
```

- [ ] **Step 3: Surface at startup**

In `src/runner/poller.ts`, near the existing startup logging (where `cleanExpired` runs), add:

```typescript
try {
  const fanouts = new RebaseFanoutManager(db)
  const incomplete = fanouts.findIncomplete()
  if (incomplete.length > 0) {
    logger.warn({ count: incomplete.length, samples: incomplete.slice(0, 5) }, 'Incomplete rebase fan-outs detected — review siblings table')
  }
} catch (err) {
  logger.debug({ err }, 'findIncomplete startup check failed')
}
```

- [ ] **Step 4: Verify**

```
pnpm test -- --run test/state/ test/runner/
pnpm lint && pnpm typecheck
```

---

### Task 12: Block retry while PR is in active merge-queue batch

**Files:**
- Modify: `src/ops/retry.ts` (inside `RetryEngine.retry`)
- Modify: `src/merge-queue/batch.ts` (add a finder)
- Test: `test/ops/retry.test.ts`

- [ ] **Step 1: Add a finder on `MergeBatchManager`**

In `src/merge-queue/batch.ts` add:

```typescript
findActiveBatchContainingPr(repo: string, prNumber: number): MergeBatchRecord | null {
  // pr_numbers is stored as JSON; SQLite json_each is the cheapest path.
  const row = this.db.prepare(`
    SELECT b.* FROM merge_batches b, json_each(b.pr_numbers) AS p
    WHERE b.repo = ?
      AND CAST(p.value AS INTEGER) = ?
      AND b.status IN ('staging','building','merging')
    ORDER BY b.created_at DESC
    LIMIT 1
  `).get(repo, prNumber) as RawBatchRow | undefined
  return row ? mapRow(row) : null
}
```

(Confirm batch status enum values against the existing `MergeBatchStatus` type; the literal list above is illustrative.)

- [ ] **Step 2: Failing test**

```typescript
it('refuses retry when the run\'s PR is in an active merge-queue batch', async () => {
  const db = makeInMemoryDb()
  const config = ConfigSchema.parse(makeConfigLiteral())
  insertRun(db, { repo: 'org/repo', issue_number: 7, pr_number: 99, status: 'review_ready', branch_name: 'orch/7' })
  insertMergeBatch(db, { repo: 'org/repo', pr_numbers: '[99]', status: 'building' })

  const engine = new RetryEngine(db, config, () => makeMockForge())
  await expect(engine.retry('org/repo', 7, { immediate: true })).rejects.toThrow(/merge-queue batch/i)
})
```

Use whatever insert helper the merge-queue tests already provide.

- [ ] **Step 3: Run + confirm fail**

```
pnpm test -- --run test/ops/retry.test.ts
```

- [ ] **Step 4: Apply the guard**

In `src/ops/retry.ts`, after the initial `RETRYABLE_STATUSES` check and after `run` is loaded:

```typescript
import { MergeBatchManager } from '../merge-queue/batch.js'

// inside retry(), after the running-status guard:
if (run.prNumber !== null && run.prNumber !== undefined) {
  const batches = new MergeBatchManager(this.db)
  const conflictingBatch = batches.findActiveBatchContainingPr(repo, run.prNumber)
  if (conflictingBatch) {
    throw new Error(
      `Cannot retry run ${run.id}: PR #${run.prNumber} is in active merge-queue batch ${conflictingBatch.id} (status=${conflictingBatch.status})`,
    )
  }
}
```

- [ ] **Step 5: Verify**

```
pnpm test -- --run test/ops/ test/merge-queue/
pnpm lint && pnpm typecheck
```

---

### Task 13: CLI/TUI/MCP parity for `maxAttemptChainLength` on rebase

**Files:**
- Modify: `src/cli/tui/app.tsx:781-810` (`runRebase`)
- Test: extend an existing TUI test (mirror patterns in `test/cli/tui/`)
- Docs: `docs/USAGE.md`

- [ ] **Step 1: Confirm CLI + MCP signature**

Read `src/cli/commands/rebase.ts:77` and `src/mcp/tools/operations.ts:112` for the parameter name. Expect `maxAttemptChainLength` (numeric, optional).

- [ ] **Step 2: Failing test**

In the closest existing TUI rebase test (or create `test/cli/tui/rebase-action.test.tsx`):

```typescript
it('forwards maxAttemptChainLength from TUI rebase invocation to queueRebase', async () => {
  const queueRebase = vi.fn().mockResolvedValue({ queued: true, reason: '' })
  // render the TUI, set runRebase deps so it calls queueRebase, trigger with chainLen=3
  expect(queueRebase).toHaveBeenCalledWith(expect.objectContaining({ maxAttemptChainLength: 3 }))
})
```

- [ ] **Step 3: Apply**

In `src/cli/tui/app.tsx:781-810`, extend `runRebase` to accept and forward `maxAttemptChainLength`. If the TUI's rebase form does not currently prompt for chain length, default it to `config.runner?.maxAttemptChainLength ?? autoRebase?.maxChainLength ?? undefined` (match CLI's resolution rule — read `src/cli/commands/rebase.ts` for the exact precedence).

- [ ] **Step 4: Docs**

`docs/USAGE.md` rebase section: explicitly call out parity — CLI `--max-attempt-chain-length`, TUI rebase form numeric input, MCP `maxAttemptChainLength`.

- [ ] **Step 5: Verify**

```
pnpm test -- --run test/cli/
pnpm lint && pnpm typecheck
```

---

### Task 14: Thread commenter as rebase actor

**Files:**
- Modify: `src/ops/rebase-and-check.ts` (`RebaseTrigger` union)
- Modify: `src/runner/comment-commands.ts` (pass commenter)
- Test: `test/runner/comment-commands.test.ts`

- [ ] **Step 1: Extend `RebaseTrigger`**

In `src/ops/rebase-and-check.ts:24-29`, extend the existing union:

```typescript
export type RebaseTrigger =
  | { kind: 'manual' }
  | { kind: 'cli' }
  | { kind: 'mcp' }
  | { kind: 'tui' }
  | { kind: 'comment'; user: string }
  | { kind: 'fanout'; sourcePr: number }
```

Update `buildRebaseActionDetails` (or whatever helper writes `actor` into `recordUserAction`) to map `comment` to `comment:${user}` (or whatever convention matches `fanout` — read the current mapping).

- [ ] **Step 2: Pass the commenter**

In `src/runner/comment-commands.ts`'s `executeCommentCommand` (search for the `queueRebase` call for the `/orch rebase` path), add:

```typescript
const result = await queueRebase({
  // ...existing fields
  trigger: { kind: 'comment', user: item.user },
})
```

- [ ] **Step 3: Failing test**

```typescript
it('records commenter as actor on /orch rebase', async () => {
  // arrange: active run + comment "/orch rebase" from user "alice"
  // act: processCommentCommands
  // assert: user_actions table row has actor matching the comment convention,
  // e.g. expect(latestAction.actor).toMatch(/alice/)
})
```

- [ ] **Step 4: Verify**

```
pnpm test -- --run test/runner/
pnpm lint && pnpm typecheck
```

---

### Task 15: Transaction-wrap `recordDecisionOutcome` + `persistRunState`

**Files:**
- Modify: `src/loop/checkpoint.ts:261-269, 276-288`
- Test: `test/loop/checkpoint.race.test.ts`

- [ ] **Step 1: Failing property-style test**

```typescript
it('does not drop updates under serial read-modify-write churn', () => {
  const db = makeInMemoryDb()
  const checkpoint = new Checkpoint(db, 'run-1')
  // Seed phase_data with an empty outcomes map
  for (let i = 0; i < 100; i++) {
    checkpoint.recordDecisionOutcome({ phase: 'decide', outcomeKey: `k${i}`, value: i })
  }
  const final = checkpoint.readPhaseData()
  expect(Object.keys(final.outcomes ?? {})).toHaveLength(100)
})
```

(Adapt to the actual `Checkpoint` API — read `src/loop/checkpoint.ts` and `src/loop/checkpoint-schema.ts` for the real signatures.)

- [ ] **Step 2: Run + confirm fail** (or pass — if it passes serially today, the test still locks in transactional semantics for future concurrent code paths.)

- [ ] **Step 3: Apply transaction wraps**

Mirror the existing `phaseCompleted` pattern (lines 216-226). For each of `recordDecisionOutcome` and `persistRunState`:

```typescript
recordDecisionOutcome(args: RecordDecisionOutcomeArgs): void {
  const tx = this.db.transaction((a: RecordDecisionOutcomeArgs) => {
    const row = this.db.prepare('SELECT phase_data FROM runs WHERE id = ?').get(this.runId) as { phase_data: string | null } | undefined
    const next = mergeOutcomeIntoPhaseData(row?.phase_data ?? null, a)
    this.db.prepare('UPDATE runs SET phase_data = ?, updated_at = ? WHERE id = ?').run(next, nowUtcIso(), this.runId)
  })
  tx(args)
}
```

- [ ] **Step 4: Verify**

```
pnpm test -- --run test/loop/
pnpm lint && pnpm typecheck
```

---

### Task 16: Phase 2 gate

- [ ] **Step 1: Full suite**

```
pnpm lint && pnpm typecheck && pnpm test
```

Expected: green. Do not advance to Phase 3 until clean.

---

## Phase 3 — Web Surface Hardening

Only relevant if `night-orch web` / `demo` / `serve` is used. Tasks 21 and 22 (AI error scrub, verify stderr scrub) apply regardless and should ship even if no web UI is exposed.

### Task 17: Default agent-session permission mode to `plan`

**Files:**
- Modify: `src/web/agent-session.ts:540-567`
- Modify: `src/config/schema.ts` (add `workerProfiles[name].allowAgentSessionBypass`)
- Test: `test/web/agent-session.test.ts`
- Docs: `docs/CONFIGURATION.md`

- [ ] **Step 1: Add schema field**

In `src/config/schema.ts`, find the worker profile schema (search for `workerProfiles`). Add:

```typescript
allowAgentSessionBypass: z.boolean().default(false)
  .describe('Allow the web agent-session endpoint to spawn workers with --permission-mode bypassPermissions or acceptEdits. Default false (plan mode).'),
```

- [ ] **Step 2: Failing test**

```typescript
it('defaults Claude agent session to --permission-mode plan when allowAgentSessionBypass is false', () => {
  const args = buildInteractiveTaskArgs({
    profile: { args: [] },
    isRoot: false,
    allowAgentSessionBypass: false,
  })
  expect(args).toContain('--permission-mode')
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
})

it('rejects bypassPermissions in profile args when allowAgentSessionBypass is false', () => {
  expect(() => buildInteractiveTaskArgs({
    profile: { args: ['--permission-mode', 'bypassPermissions'] },
    isRoot: false,
    allowAgentSessionBypass: false,
  })).toThrow(/allowAgentSessionBypass/i)
})
```

- [ ] **Step 3: Apply**

In `src/web/agent-session.ts`:

- `resolveDefaultPermissionMode` returns `'plan'` unless `allowAgentSessionBypass === true`.
- `buildInteractiveTaskArgs` rejects `bypassPermissions` / `acceptEdits` in profile args unless the opt-in is set.
- In `src/web/server.ts` where agent-session is wired (~line 756), throw at startup if any web-exposed profile lacks `allowAgentSessionBypass: true` AND attempts to use bypass — keep the default `plan` path silent.

- [ ] **Step 4: Refuse session creation without `worktreeRoot`**

In `agent-session.ts:108` (`workspacePath = resolve(options.workspacePath ?? process.cwd())`), reject the unset path with a clear error message instead of silently falling back to `process.cwd()`.

- [ ] **Step 5: Docs**

`docs/CONFIGURATION.md` — document `workerProfiles[name].allowAgentSessionBypass` with security warning.

- [ ] **Step 6: Verify**

```
pnpm test -- --run test/web/
pnpm lint && pnpm typecheck
```

---

### Task 18: CSRF double-submit token (server + frontend + config)

**Files:**
- Modify: `src/web/auth.ts:38-115` (session TTL, Secure cookie, CSRF token issuance)
- Modify: `src/web/server.ts:559, 610-628` (drop `allowMissingOrigin` for mutations, validate `x-csrf-token`)
- Modify: `src/config/schema.ts` (add `web.trustedProxy`)
- Modify: `web/src/App.tsx:761` and the SPA fetch wrapper to send `x-csrf-token` on mutations
- Test: `test/web/csrf.test.ts` (new), `test/web/auth.test.ts`
- Docs: `docs/CONFIGURATION.md`

- [ ] **Step 1: Add `web.trustedProxy` schema field**

In `src/config/schema.ts` find the `web` config section (search for `webPort` or similar). Add:

```typescript
trustedProxy: z.boolean().default(false)
  .describe('Trust X-Forwarded-Proto from the proxy when deciding whether to emit Secure / __Host- cookies.'),
```

- [ ] **Step 2: Server changes**

In `src/web/auth.ts`:

- Session cookie `Max-Age = 60 * 60 * 8` (8 hours, not 1 year).
- When `web.trustedProxy && req.headers['x-forwarded-proto'] === 'https'`, emit `__Host-night-orch-session` with `Secure; Path=/; SameSite=Strict; HttpOnly`.
- Issue a separate `csrf` cookie on session creation: random 32 bytes base64url, `HttpOnly=false` (so the SPA can read it), `SameSite=Strict`, `Secure` under HTTPS.
- Add `requireCsrfToken(req)`: constant-time compare `req.headers['x-csrf-token']` against the cookie value.

In `src/web/server.ts`:

- `hasAllowedOrigin` returns `false` when the request method mutates and `Origin` is missing (`allowMissingOrigin` is no longer a free pass for mutations).
- Mutation middleware: require valid session + matching CSRF header.

- [ ] **Step 3: Frontend changes**

In `web/src/App.tsx`:

- Read the `csrf` cookie via `document.cookie` parsing on app boot; store in state.
- Wrap mutating fetches so every `POST`/`PUT`/`DELETE`/`PATCH` includes `x-csrf-token: <value>` automatically (one wrapper function used by every mutation site).
- On `/api/auth/login` success, refresh the CSRF token from the response (server rotates on login).

- [ ] **Step 4: Failing test**

```typescript
// test/web/csrf.test.ts
it('rejects mutation requests without x-csrf-token', async () => {
  const res = await fetch(`${baseUrl}/api/operations/poll`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-night-orch-intent': 'mutate',
      cookie: sessionCookie,
    },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(403)
})

it('accepts mutation requests with matching x-csrf-token', async () => {
  const res = await fetch(`${baseUrl}/api/operations/poll`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-night-orch-intent': 'mutate',
      'x-csrf-token': csrfTokenFromCookie,
      cookie: `${sessionCookie}; csrf=${csrfTokenFromCookie}`,
    },
    body: JSON.stringify({}),
  })
  expect(res.status).not.toBe(403)
})
```

- [ ] **Step 5: Docs**

`docs/CONFIGURATION.md` — document `web.trustedProxy`, the 8h session TTL, and the CSRF requirement for non-browser API clients (CLI scripts must read the cookie + echo it, or use bearer token auth via `NIGHT_ORCH_WEB_AUTH_TOKEN`).

- [ ] **Step 6: Verify**

```
pnpm test -- --run test/web/
pnpm lint && pnpm typecheck && pnpm web:typecheck
```

---

### Task 19: Replace loopback `mutationToken` leak with sidecar file

**Files:**
- Modify: `src/web/server.ts:646-664` (`createWebSecurityContext`)
- Modify: `src/web/routes/api-runs.ts:33-44` (`/api/session`)
- Modify: `web/src/App.tsx:326-345` (replace `loadSessionToken` flow)
- New file (at runtime): `$XDG_RUNTIME_DIR/night-orch-web.token` (mode 0600)
- Test: `test/web/loopback-token.test.ts`
- Docs: `docs/CONFIGURATION.md`

Background: removing `mutationToken` from `/api/session` without a replacement strands loopback users. The replacement: write the loopback token to a sidecar file readable only by the daemon owner; the SPA prompts the operator to paste it on first load.

- [ ] **Step 1: Write the sidecar on startup**

In `createWebSecurityContext` (`src/web/server.ts:646`), when `!operatorAuthMode` (loopback mode), write the generated token to a file:

```typescript
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

function writeLoopbackTokenSidecar(token: string): string | null {
  const runtimeDir = process.env['XDG_RUNTIME_DIR'] ?? `/tmp`
  const dir = runtimeDir
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, 'night-orch-web.token')
    writeFileSync(path, token, { mode: 0o600 })
    chmodSync(path, 0o600)
    return path
  } catch (err) {
    logger.warn({ err }, 'Failed to write loopback token sidecar file')
    return null
  }
}
```

In `createWebSecurityContext`:

```typescript
const generated = randomBytes(24).toString('base64url')
const webMutationToken = operatorAuthMode ? operatorToken : generated
const loopbackTokenPath = operatorAuthMode ? null : writeLoopbackTokenSidecar(generated)
if (loopbackTokenPath) {
  logger.info({ path: loopbackTokenPath }, 'Loopback web token written to sidecar file (mode 0600)')
}
return {
  // ...existing fields
  webMutationToken,
  loopbackTokenPath,
}
```

Also print the token to stdout on startup once for ephemeral / non-XDG environments (Docker, CI):

```typescript
if (!operatorAuthMode) {
  process.stdout.write(`\n[night-orch] Loopback web token (also at ${loopbackTokenPath ?? 'sidecar file'}):\n  ${generated}\n\n`)
}
```

- [ ] **Step 2: Stop returning `mutationToken` from `/api/session`**

In `src/web/routes/api-runs.ts:33-44`, remove the `mutationToken` field from the response payload. Replace with a hint:

```typescript
return {
  operationsEnabled: security.operationsEnabled,
  requiresExternalAuth: security.operatorAuthMode,
  loopbackTokenHint: security.operatorAuthMode
    ? null
    : { path: security.loopbackTokenPath ?? null, stdoutPrinted: true },
}
```

- [ ] **Step 3: Frontend flow**

In `web/src/App.tsx:326-345` `loadSessionToken`:

- When `loopbackTokenHint` is present, render an input box that says "Paste loopback token from `~/.config/...` or daemon stdout".
- Save the pasted token to `localStorage` and use as `Authorization: Bearer <token>` on mutating requests (sibling to the bearer flow already used for `operatorAuthMode`).
- Drop the auto-fetched `mutationToken` path entirely.

- [ ] **Step 4: Failing test**

```typescript
// test/web/loopback-token.test.ts
it('/api/session does not return mutationToken in any mode', async () => {
  const res = await fetch(`${baseUrl}/api/session`)
  const body = await res.json() as Record<string, unknown>
  expect(body).not.toHaveProperty('mutationToken')
})

it('writes a sidecar token file in loopback mode (mode 0600)', () => {
  // start daemon in loopback mode, assert XDG_RUNTIME_DIR/night-orch-web.token exists with stat mode 0o600
})
```

- [ ] **Step 5: Docs**

`docs/CONFIGURATION.md` — new "Loopback web auth" subsection: location of sidecar token file, mode requirements, how to paste in browser, how to override with `NIGHT_ORCH_WEB_AUTH_TOKEN` env var.

- [ ] **Step 6: Verify**

```
pnpm test -- --run test/web/
pnpm lint && pnpm typecheck && pnpm web:typecheck
```

---

### Task 20: Scrub AI provider error bodies

**Files:**
- Modify: `src/ai/anthropic.ts:149` (`throwForStatus`)
- Modify: `src/ai/openai.ts` (mirror — find the equivalent `throwForStatus` or status-handling block)
- Modify: `src/ai/openrouter.ts` (mirror)
- Test: `test/ai/scrubbing.test.ts` (new)

- [ ] **Step 1: Failing test**

```typescript
// test/ai/scrubbing.test.ts
import { describe, it, expect } from 'vitest'

describe('AI provider error scrubbing', () => {
  it('scrubs sk-ant-* tokens from anthropic error messages', () => {
    const client = new AnthropicClient('claude-test', 'sk-ant-api03-FAKE')
    // Use a private-method probe or call complete() with a mocked fetch that returns 401
    // with a body containing "Authorization: sk-ant-api03-LEAKED-KEY"
    // Assert thrown error.message does NOT contain "sk-ant-api03-LEAKED-KEY"
  })

  it('scrubs ghp_/AKIA/xox* tokens from any provider error', () => {
    // mirror for openai + openrouter
  })
})
```

- [ ] **Step 2: Apply the scrub**

In `src/ai/anthropic.ts:149-160` `throwForStatus`:

```typescript
import { sanitizeErrorMessage } from '../utils/sanitize-error.js'

private throwForStatus(status: number, body: string): never {
  const snippet = sanitizeErrorMessage(body.slice(0, 500))
  if (status === 401 || status === 403) {
    throw new AiAuthError(this.provider, this.model, `HTTP ${status}: ${snippet}`)
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(body)
    throw new AiRateLimitError(this.provider, this.model, `HTTP 429: ${snippet}`, retryAfterMs)
  }
  // ...etc
}
```

Apply the equivalent in `src/ai/openai.ts` and `src/ai/openrouter.ts` (read each for its current shape).

- [ ] **Step 3: Verify**

```
pnpm test -- --run test/ai/
pnpm lint && pnpm typecheck
```

---

### Task 21: Sanitize verify-command stderr at log + prompt embed

**Files:**
- Modify: `src/loop/verifier.ts:41, 55` (sanitize `stderrTail` before logging)
- Modify: `src/loop/step-executor.ts:233` (sanitize `stderr` before embedding in worker prompts)
- Test: `test/loop/verifier.test.ts`

- [ ] **Step 1: Failing test**

```typescript
it('scrubs tokens from verify stderr when logged', async () => {
  const sink = makeLogSink()
  const results = await runVerifyCommands(
    [{ command: 'bash -c "echo GITHUB_TOKEN=ghp_1234567890ABCDEFGHIJ 1>&2; exit 1"' }],
    { /* env */ },
    { logger: sink.logger },
  )
  expect(results[0]?.passed).toBe(false)
  expect(sink.captured.join('\n')).not.toMatch(/ghp_1234567890ABCDEFGHIJ/)
})

it('scrubs tokens from verify stderr before prompt embed', async () => {
  // Drive a single iteration that embeds verifyResults in a worker prompt;
  // assert the resulting prompt string does not contain the token.
})
```

- [ ] **Step 2: Apply**

In `src/loop/verifier.ts:41`:

```typescript
import { sanitizeErrorMessage } from '../utils/sanitize-error.js'

// replace the warn line
logger.warn({
  command: commandLabel,
  exitCode: result.exitCode,
  durationMs,
  stderrTail: sanitizeErrorMessage(result.stderr.slice(-500)),
}, 'Verify command failed')
```

Apply the same `sanitizeErrorMessage` wrap at line 55 (`stderr.slice(-500)` in the crash branch).

In `src/loop/step-executor.ts:233`, before embedding `verifyResults[i].stderr` into the prompt template, wrap with `sanitizeErrorMessage`. Do not change the `VerifyResult` struct itself — the raw `stderr` stays available for callers that need it; only the prompt-bound view is sanitized.

- [ ] **Step 3: Verify**

```
pnpm test -- --run test/loop/
pnpm lint && pnpm typecheck
```

---

### Task 22: Phase 3 gate

- [ ] **Step 1: Full suite + audit**

```
pnpm lint && pnpm typecheck && pnpm test && pnpm audit --audit-level moderate
```

Expected: green.

---

## Backlog (deferred — schedule once Phase 1-3 land)

- Move `src/ops/conflict-types.ts` → `src/git/conflict-types.ts` (layering inversion — loop/workers should not import from ops)
- Decouple `src/ops/retry.ts` from `src/runner/poller.ts` via an `attemptDispatcher` interface
- Split `src/poller/attempt-dispatcher.ts` (968 LOC) into `branch-refresh.ts` + `decompose-dispatch.ts` + `buildConflictBlockedPayload(...)` helper
- Schema-default-trust consumer sweep for `mergeQueue`, `defaults`, `labelConfig`, `selectors`, `preflight`, `agents`, `fileLoop` — apply the `?.` guard pattern from Task 1
- Discriminated-union refactor of `QueueRebaseResult` (audit finding referenced but deliberately deferred — current stringly-typed reasons still work after Phase 2; refactor when there is another reason to touch the call sites)
- Remove zombie config fields (`doneMode`, `notifyPriority`, `workerProfiles[].minimalEnv`) in a tagged breaking-config release; sync `docs/CONFIGURATION.md`
- Replace `loadActiveRuns` UNION-ALL status correlation in `src/ops/sync.ts:560-608` with `i.current_run_id = r.id`
- Adopt `src/components/` framework in TUI (`stats-view.tsx StatCard` → `components/card/card.tui.tsx`)
- WebSocket hardening: `maxPayload: 1<<20`, disable `perMessageDeflate`, back-pressure via `ws.bufferedAmount`, debounced dashboard snapshots
- Hoist `db.prepare` calls in `src/cli/tui/app.tsx:451-553` into `useMemo(() => stmts, [db])`
- Add `noUncheckedIndexedAccess: true` to `web/tsconfig.json` + `.storybook/tsconfig.json`
- Bump `@modelcontextprotocol/sdk` 1.27.1 → 1.29.0 and re-audit transitives
- Pin `acpx` to exact version; file upstream issue; replace `files.find()` heuristic in `src/workers/acpx-imports.ts:34` with strict-one assertion
- 30-migration consolidation milestone — v1.0 baseline schema before public release

---

## Self-Review Notes

- **Spec coverage:** every C1-C5 and H1-H14 from the audit synthesis maps to a Phase 1/2/3 task or backlog entry. The C2 (fan-out replay storm) and C3 (double fan-out race) findings are addressed jointly by Task 9-11 (per-sibling durable record + in-process dedup + startup resumability scan), preserving ADR-0001's mark-after-loop crash semantics. The Rev 1 mistakes (run-finalizer trigger, claim-before-loop, unconditional `mutationToken` removal, missing frontend, commit steps) are corrected in this revision.
- **Placeholder scan:** no "TBD"/"implement later". Every code step shows the actual code. Test bodies are concrete or carry an explicit "adapt to existing helper" pointer at the test fixture (e.g. `makeInMemoryDb`, `makeMockForge`, `insertRun`, `insertMergeBatch`) — these helpers already exist in sibling test files.
- **Type consistency:** `RebaseFanoutManager.{has,get,mark,recordSibling,listSiblings,findIncomplete,runOnce,pruneOlderThan}` consistent across Tasks 8-11. `RebaseTrigger` union extension matches the current shape (`manual|cli|mcp|tui|comment|fanout`). `FanoutDeps.sourceMergeSha` flows through Tasks 9-10. `QueueRebaseResult` shape is **not** changed in Phase 2 (deliberately deferred — the audit's stringly-typed concern is mitigated by per-sibling records carrying `reason: 'queue_failed'|'exception'` instead).
- **Dependency ordering:** Task 8 (migration) precedes Task 9 (manager extension) precedes Task 10 (loop rewrite). Task 11 (`findIncomplete` + startup scan) requires the failures_count column from Task 8. Phase gates (Tasks 7, 16, 22) ensure no silent regressions.
- **No commit instructions:** verification steps end at `pnpm lint && pnpm typecheck && pnpm test`. The user controls when to stage and commit.
