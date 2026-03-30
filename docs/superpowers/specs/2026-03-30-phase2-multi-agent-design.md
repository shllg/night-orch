# Phase 2: Multi-Agent Capabilities — Design Spec

## Context

Night-orch currently processes issues serially with hardcoded Claude/Codex adapters and no ability to decompose complex issues. Phase 2 adds:

1. Agent-agnostic type system + ACP adapter (via acpx)
2. Task decomposer for composite issues
3. Parallel sub-task execution in isolated worktrees
4. Active worker supervision

## Section 1: Agent-Agnostic Type System + ACP Adapter

### Type Changes

**`WorkerProfileInput.type`** changes from `'claude' | 'codex'` to `string`. Validation moves from Zod enum to runtime check against registered adapters.

**`WorkerAdapterRegistry`** replaces the switch-case factory:

```typescript
// src/workers/registry.ts
interface WorkerAdapterFactory {
  create(): WorkerAdapter
  checkAvailability(): Promise<{ available: boolean; version: string | null }>
}

class WorkerAdapterRegistry {
  private factories = new Map<string, WorkerAdapterFactory>()
  register(type: string, factory: WorkerAdapterFactory): void
  create(profile: WorkerProfileInput): WorkerAdapter
  getRegisteredTypes(): string[]
}
```

Built-in registrations: `claude`, `codex`, `acp`. The existing `createWorkerAdapter()` function delegates to the registry.

**`WorkerTaskResult`** gains optional token usage:

```typescript
tokenUsage?: {
  promptTokens: number
  completionTokens: number
}
```

When present, cost tracking uses real token counts instead of time-based estimates.

### ACP Adapter (`src/workers/acp.ts`)

**Dependency:** `pnpm add acpx`

**Implementation:**

- Uses `runOnce()` from `acpx/dist/session-runtime.js` for isolated invocations
- Uses `sendSessionDirect()` when `continueSessionId` is provided
- Collects assistant text output via `onSessionUpdate` callback accumulating text content blocks
- Extracts token usage from session record's `cumulative_token_usage`
- Configuration: `permissionMode: 'approve-all'`, `nonInteractivePermissions: 'deny'`

**Config shape:**

```yaml
workerProfiles:
  gemini-acp:
    type: acp
    command: gemini        # acpx agent name (not CLI command)
    args: []               # additional acpx args
    workerTimeoutSeconds: 1800
    env: {}
```

The `command` field for ACP profiles specifies the acpx agent name (e.g., `codex`, `claude`, `gemini`, `pi`). ACPX resolves this to the correct ACP adapter command.

**Error handling:**

- `AcpxOperationalError` with `retryable: true` → throw retryable error (poller auto-retries)
- `AcpxOperationalError` with `retryable: false` → throw permanent error
- Timeout from ACPX → map to `timedOut: true` on `WorkerTaskResult`

**Session continuity:**

- `runOnce()` returns `{ sessionId }` — stored in `WorkerTaskResult.sessionId`
- When `input.continueSessionId` is set, use `sendSessionDirect()` with the prior session
- Falls back to `runOnce()` if session resume fails (session may have been cleaned up)

### Files to create/modify

- Create: `src/workers/registry.ts`
- Create: `src/workers/acp.ts`
- Modify: `src/workers/types.ts` (type → string, add tokenUsage)
- Modify: `src/workers/factory.ts` (delegate to registry)
- Modify: `src/config/schema.ts` (type enum → string, add validation)
- Modify: `src/loop/engine.ts` (use tokenUsage for cost when available)

## Section 2: Task Decomposer

### Module: `src/discovery/decomposer.ts`

**Interface:**

```typescript
interface SubTask {
  title: string
  description: string
  dependencies: number[]  // indexes of subtasks this depends on
  estimatedComplexity: 'trivial' | 'standard'
}

interface DecompositionResult {
  shouldDecompose: boolean
  subtasks: SubTask[]
  reasoning: string
}

async function decomposeIssue(
  issue: ForgeIssue,
  adapter: WorkerAdapter,
  profile: WorkerProfileInput,
  env: Record<string, string>,
  worktreePath: string,
): Promise<DecompositionResult>
```

**When decomposition triggers:**

- `loop.decompose` config is `true` (default: `false`, opt-in)
- Triage level is `standard` (not trivial or architectural)
- Issue body length > 500 characters OR body contains 3+ numbered items/headings

**Decomposition prompt:**

Sent to the planner adapter with role `'planner'`. The prompt asks:
1. Should this issue be split? (Some issues are naturally atomic)
2. If yes, list 2-5 atomic sub-tasks with titles, descriptions, and dependency ordering
3. Output as JSON with the `DecompositionResult` schema

**Parser:** `src/workers/parsers/decomposer.ts` — validates against Zod schema, falls back to single-task (no decomposition) if parsing fails.

### Config addition

```yaml
loop:
  decompose: false                # opt-in
  maxSubtasks: 5                  # cap to prevent runaway decomposition
  maxConcurrentSubtasks: 3        # parallel worktree limit
```

### Files to create/modify

- Create: `src/discovery/decomposer.ts`
- Create: `src/workers/parsers/decomposer.ts`
- Modify: `src/config/schema.ts` (add decompose, maxSubtasks, maxConcurrentSubtasks)
- Modify: `src/runner/poller.ts` (call decomposer before executeLoop)

## Section 3: Parallel Sub-Task Execution

### Module: `src/loop/parallel.ts`

**Interface:**

```typescript
interface SubTaskResult {
  subtask: SubTask
  ctx: RunContext
  worktreePath: string
  success: boolean
}

async function executeParallelSubtasks(
  parentCtx: RunContext,
  subtasks: SubTask[],
  deps: LoopDependencies,
): Promise<{ results: SubTaskResult[]; mergedCtx: RunContext }>
```

**Execution model:**

1. Create a worktree per subtask, all branched from the same base commit
2. Group subtasks into waves based on dependency graph (topological sort)
3. Within each wave, run subtasks concurrently up to `maxConcurrentSubtasks`
4. Each subtask runs `executeLoop()` independently with its own `RunContext`
5. After all subtasks complete, merge results

**Merge strategy:**

1. Create a merge branch from base
2. Cherry-pick each successful subtask's commits in dependency order
3. If cherry-pick conflicts: mark that subtask as `needs_manual_merge`, skip it
4. Run final verification on the merged branch
5. Publish one PR with all merged changes (sub-task summaries in PR body)

**DB schema change:**

New nullable column on `runs` table:

```sql
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id);
```

New migration: `006-parent-run.ts`

**Parent run tracking:**

- Parent run status = `running` while subtasks execute
- Parent transitions to `publish` when merge succeeds
- Parent transitions to `blocked` if any critical subtask fails
- Sub-run records link to parent via `parent_run_id`

### Lease management

Each sub-task acquires its own lease on the same issue (different lease_owner: `poller:subtask-{index}`). The parent lease remains held.

### Files to create/modify

- Create: `src/loop/parallel.ts`
- Create: `src/state/migrations/006-parent-run.ts`
- Modify: `src/state/runs.ts` (add parentRunId field, queries for sub-runs)
- Modify: `src/runner/poller.ts` (fork between single/parallel execution)
- Modify: `src/publishing/pr-body.ts` (include sub-task summaries)

## Section 4: Active Worker Supervision

### Module: `src/loop/supervisor.ts`

**Interface:**

```typescript
interface SupervisorHandle {
  cancel(): void
}

function superviseWorker(
  role: string,
  timeoutMs: number,
  onStuck: () => void,
): SupervisorHandle
```

**Behavior:**

- Starts a timer when a worker is invoked
- At `0.8 * timeoutMs`: logs warning "worker may be stuck"
- At `timeoutMs`: calls `onStuck()` which sends SIGTERM to the worker process
- Cancelled when worker completes normally

**Integration:** Called in `runWorkerStep()` in the engine, wrapping `adapter.runTask()`.

This is lighter than Gastown's Witness pattern — no separate process, just a timer coroutine.

### Files to create/modify

- Create: `src/loop/supervisor.ts`
- Modify: `src/loop/engine.ts` (wrap runTask with supervisor)

## Testing Strategy

- **ACP adapter:** Mock `runOnce`/`sendSessionDirect` from acpx, test event collection and error mapping
- **Registry:** Test registration, creation, unknown type errors
- **Decomposer:** Test prompt generation, output parsing, threshold detection, fallback to no-decompose
- **Parallel execution:** Test dependency graph sorting, wave grouping, merge conflict handling (mock git)
- **Supervisor:** Test timer firing, cancellation, stuck detection
- **Integration:** Full loop with decomposition enabled, verify sub-runs created and merged

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm test
```

End-to-end: Run against a test repo with a multi-requirement issue and `decompose: true`.
