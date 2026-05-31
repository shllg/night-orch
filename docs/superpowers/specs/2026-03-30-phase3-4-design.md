# Phase 3+4: Developer Experience & Advanced Features — Design Spec

## Context

Night-orch has a working core (777 tests, Phase 1+2 complete). Phases 3+4 add: configurable workflow templates, a merge queue, CLI onboarding, and a monitoring TUI.

## Section 1: Configurable Workflow Templates

### Problem

The loop engine has a hardcoded Plan→Code→Verify→Review→Decide pipeline. Users can't:
- Skip planning for trivial issues via config (only via triage heuristic)
- Add a security review step for auth-related code
- Add a migration review step for DB changes
- Reorder phases or add custom worker steps

### Design

**Approach:** Keep existing typed RunContext fields for built-in roles. Add `stepOutputs: Record<string, unknown>` for custom steps. Extract `runWorkerStep` into a reusable step executor. Replace the hardcoded loop with a step-list iterator that supports conditional skip and jump-back on iterate.

**Workflow config (YAML, per-repo or global):**

```yaml
workflows:
  default:
    steps:
      - id: plan
        type: worker
        role: planner
        skipWhen: trivial    # skip if triage level matches
      - id: code
        type: worker
        role: coder
        continueFrom: plan   # session continuity
      - id: verify
        type: verify
      - id: review
        type: worker
        role: reviewer
      - id: decide
        type: decide
        onIterate: code      # jump target
```

**Built-in step types:**
- `worker` — invoke a worker adapter with role/prompt
- `verify` — run configured verify commands
- `decide` — evaluate the pure decide() function, route to publish/iterate/block

**Type changes:**
- `LoopPhase` becomes `string` (was fixed union)
- `PhaseRecord.phase` becomes `string`
- `RunContext` gains `stepOutputs: Readonly<Record<string, unknown>>`
- `LoopDependencies` gains `adapters: Record<string, WorkerAdapter>` and `workflow: ResolvedWorkflow`
- Existing `plannerAdapter/coderAdapter/reviewerAdapter` removed from LoopDependencies

**Backward compatibility:**
- `DEFAULT_WORKFLOW` constant matches current hardcoded behavior exactly
- When no `workflow` config is set, `resolveWorkflow()` returns DEFAULT_WORKFLOW
- Existing typed fields (`plan`, `codeResult`, `reviewResult`) remain and are populated by built-in role executors
- Checkpoint resume detects legacy format (hardcoded keys) vs new format (step-ID keys)

### Files

- Create: `src/loop/workflow.ts` — WorkflowStep types, DEFAULT_WORKFLOW, resolveWorkflow()
- Create: `src/loop/step-executor.ts` — generic executeStep() extracted from engine.ts
- Modify: `src/loop/engine.ts` — replace hardcoded phases with workflow step iteration
- Modify: `src/loop/types.ts` — LoopPhase→string, add stepOutputs to RunContext
- Modify: `src/loop/checkpoint.ts` — generic resume with legacy fallback
- Modify: `src/config/schema.ts` — WorkflowStepSchema, WorkflowSchema
- Modify: `src/runner/poller.ts` — construct adapter map, resolve workflow
- Modify: `src/loop/parallel.ts` — same adapter map change

## Section 2: CLI Onboarding Wizard

### Problem

Setting up night-orch requires manually writing YAML config. No guided experience.

### Design

New command: `night-orch init` (interactive setup wizard).

**Flow:**
1. Ask for GitHub token env var name (validate with forge auth)
2. Ask for repo URL (validate it exists, detect base branch)
3. Ask for local clone path (validate or offer to clone)
4. Auto-detect project type (look for package.json, Cargo.toml, etc.)
5. Suggest verify commands based on project type
6. Suggest worker profiles (claude/codex/acp)
7. Write config file to `~/.config/night-orch/config.yaml`
8. Run `doctor` checks
9. Offer to run `labels-init`

**Dependencies:** Uses `readline` (Node built-in) for prompts. No new npm dependencies.

### Files

- Create: `src/cli/commands/init.ts` — the init wizard
- Create: `src/cli/init/detector.ts` — project type detection
- Create: `src/cli/init/templates.ts` — config templates per project type
- Modify: `src/cli/index.ts` — register init command

## Section 3: Monitoring TUI

### Problem

`night-orch status` dumps a static table. No live view of what's happening.

### Design

New command: `night-orch watch` — live-updating terminal dashboard.

**Uses `ink` (React for terminals)** — well-maintained, TypeScript-native, used by Vitest/Prettier/etc.

**Layout:**
```
┌─ Active Runs ──────────────────────────────────────┐
│ #42 org/repo  ● running  [code] iter 2/4  $0.12    │
│ #17 org/other ○ queued   [plan]           $0.00    │
└────────────────────────────────────────────────────┘
┌─ Merge Queue ──────────────────────────────────────┐
│ Batch #1: PRs #42,#43,#44  testing  (2m elapsed)   │
└────────────────────────────────────────────────────┘
┌─ Cost ─────────────────────────────────────────────┐
│ Today: $4.23 / $50.00  [████████░░░░░░░]  8.5%     │
└────────────────────────────────────────────────────┘
┌─ Recent ───────────────────────────────────────────┐
│ ✓ #41 org/repo     completed  3 iter  $0.45  12m   │
│ ■ #39 org/repo     blocked    cost_limit     $10   │
│ ✗ #38 org/other    error      timeout              │
└────────────────────────────────────────────────────┘
```

**Refresh:** Polls SQLite every 2 seconds (cheap — local DB).

### Files

- Create: `src/cli/commands/watch.ts` — the watch command
- Create: `src/cli/tui/app.tsx` — main Ink app component
- Create: `src/cli/tui/active-runs.tsx` — active runs panel
- Create: `src/cli/tui/cost-bar.tsx` — cost progress bar
- Create: `src/cli/tui/recent-runs.tsx` — recent runs table
- Create: `src/cli/tui/merge-queue.tsx` — merge queue status
- Modify: `src/cli/index.ts` — register watch command
- Add dependency: `ink`, `react`, `@types/react`

## Section 4: Merge Queue

### Problem

Night-orch creates PRs but doesn't manage merging. PRs pile up, conflicts accumulate, and humans must manually merge.

### Design

**Bors-style merge queue** integrated into the poller cycle.

**Flow:**
1. **Eligibility scan:** Each poll cycle, find `review_ready` PRs with passing CI and (optionally) human approval
2. **Batch formation:** Group up to N eligible PRs into a batch
3. **Staging branch:** Create a staging branch, sequentially merge each PR (ejecting on conflict)
4. **Test the batch:** Push staging branch, wait for CI
5. **On pass:** Fast-forward base branch to staging tip, close PRs as merged
6. **On fail:** Bisect — split batch in half, test each half, recurse until culprit found
7. **On culprit:** Eject the failing PR, label it `no:merge-failed`, re-queue remaining PRs

**DB schema (migration 007):**

```sql
CREATE TABLE merge_batches (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  staging_branch TEXT,
  staging_sha TEXT,
  pr_numbers TEXT NOT NULL,      -- JSON array
  approved_shas TEXT NOT NULL,    -- JSON array (pinned at enqueue)
  retry_count INTEGER DEFAULT 0,
  parent_batch_id TEXT,           -- for bisected sub-batches
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_merge_batches_repo_status ON merge_batches(repo, status);
```

**Config (per-repo):**

```yaml
repos:
  - repo: org/repo
    mergeQueue:
      enabled: false
      batchSize: 5
      mergeMethod: merge         # merge|squash|rebase
      retryFlakyOnce: true
      requireApproval: true
      stagingBranchPrefix: orch/staging
```

**Label additions:** `no:merge-queued`, `no:merging`, `no:merge-failed`

**ForgeAdapter additions:**
- `getRefCheckStatus?(repo, sha)` — CI status for arbitrary ref (staging branch has no PR)
- `updateRef?(repo, ref, sha, force?)` — fast-forward base branch via API

**Poller integration:** New phase in `pollOnce()` after reaction scanning, before issue discovery.

### Files

- Create: `src/merge-queue/batch.ts` — MergeBatchManager (SQLite CRUD)
- Create: `src/merge-queue/eligibility.ts` — find merge-eligible PRs
- Create: `src/merge-queue/staging.ts` — create staging branch, sequential merges
- Create: `src/merge-queue/runner.ts` — processMergeQueue() orchestrator
- Create: `src/merge-queue/bisect.ts` — pure bisection logic
- Create: `src/merge-queue/finalize.ts` — fast-forward merge, PR cleanup
- Create: `src/state/migrations/007-merge-queue.ts`
- Modify: `src/state/db.ts` — register migration
- Modify: `src/forge/types.ts` — add getRefCheckStatus, updateRef
- Modify: `src/forge/github.ts` — implement new methods
- Modify: `src/config/schema.ts` — MergeQueueSchema on RepoConfig
- Modify: `src/labels/transitions.ts` — merge-related label transitions
- Modify: `src/labels/config.ts` — new label fields
- Modify: `src/labels/bootstrap.ts` — label definitions for labels-init
- Modify: `src/runner/poller.ts` — call processMergeQueue()

## Testing Strategy

- **Workflow engine:** Test DEFAULT_WORKFLOW produces identical behavior to hardcoded engine. Test custom workflows with skip, reorder, custom steps. Test checkpoint resume for both legacy and new format.
- **Init wizard:** Test project type detection. Config template generation. (Interactive prompts tested via mock stdin.)
- **TUI:** Snapshot tests for Ink components. (Light coverage — UI is best tested visually.)
- **Merge queue:** Test eligibility scanning, batch formation, staging branch construction (mock git), bisection (pure function — exhaustive), fast-forward finalize (mock git), CI polling.

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm test
```
