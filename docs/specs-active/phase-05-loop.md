# Phase 5: Loop Engine + Verification + Guardrails

## Objective

Implement the Ralph loop state machine (PLAN → CODE → VERIFY → REVIEW → decision), `RunContext` threading, phase checkpointing for crash recovery, cost circuit breakers, and iteration limits. After this phase, the orchestrator can run the full plan→code→verify→review cycle with proper guardrails.

## Dependencies

- **Phase 4**: Worker adapters can execute planner/coder/reviewer tasks and return structured results.
- **Phase 3**: Worktree exists with correct branch and environment.
- **Phase 2**: Run record exists, issue metadata available.
- **Phase 1**: Config (loop settings, security limits), SQLite, logger.

## Inputs

- Run record with resolved roles, worktree path, branch name
- Loop config (maxReviewIterations, maxTotalAgentPasses, etc.)
- Security config (maxChangedFiles, maxChangedLines, maxCostPerRunUsd, maxDailyCostUsd)
- Verify commands from repo config
- Worker adapters (planner, coder, reviewer)

## Outputs

- Complete loop execution with structured state transitions
- `RunContext` threaded through all phases
- Phase checkpointing in SQLite for crash recovery
- Verification command runner (orchestrator-owned, not agent-owned)
- Cost tracking and circuit breakers
- Diff-size guard before commit
- Decision engine that routes based on review verdict

---

## Interfaces / Types

### RunContext

```typescript
/** Immutable context threaded through every loop step.
 *  Each step returns a new RunContext with updated fields.
 *  This is the core pattern for testability and logging. */
interface RunContext {
  readonly runId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issue: ForgeIssue;
  readonly repoConfig: RepoConfig;
  readonly roles: ResolvedRoles;
  readonly triageResult: TriageResult;
  readonly adjustedLimits: TriageAdjustedLimits;
  readonly branchName: string;
  readonly worktreePath: string;

  // Accumulated state — grows as phases complete
  readonly plan: PlannerOutput | null;
  readonly codeResult: CoderOutput | null;
  readonly verifyResults: VerifyResult[];
  readonly reviewResult: ReviewerOutput | null;
  readonly reviewFindings: ReviewFinding[];  // accumulated across iterations

  // Counters
  readonly iteration: number;
  readonly totalAgentPasses: number;

  // Cost tracking
  readonly estimatedCostUsd: number;

  // Phase tracking
  readonly currentPhase: LoopPhase;
  readonly phaseHistory: PhaseRecord[];

  // Flags
  readonly dryRun: boolean;
}

type LoopPhase =
  | 'plan'
  | 'code'
  | 'verify'
  | 'review'
  | 'decision'
  | 'publish'
  | 'notify'
  | 'completed'
  | 'blocked'
  | 'error';

interface PhaseRecord {
  phase: LoopPhase;
  startedAt: string;
  completedAt: string;
  result: 'success' | 'failure' | 'skipped';
  artifacts: Record<string, unknown>;
}
```

### Loop Engine

```typescript
interface LoopEngine {
  /** Run the full loop for a claimed issue.
   *  Returns the final RunContext with terminal state. */
  execute(initialCtx: RunContext): Promise<RunContext>;
}

/** Each loop step is a pure-ish function: context in, context out.
 *  Side effects (worker exec, git, DB) happen inside but the
 *  interface remains (ctx) → Promise<ctx>. */
type LoopStep = (ctx: RunContext) => Promise<RunContext>;
```

### Verification

```typescript
interface VerifyResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  passed: boolean;
}

interface Verifier {
  /** Run all configured verify commands sequentially in the worktree.
   *  Returns results for each command.
   *  Continues running all commands even if one fails (collect all results). */
  runAll(worktreePath: string, commands: string[]): Promise<VerifyResult[]>;

  /** Check if all verify results passed. */
  allPassed(results: VerifyResult[]): boolean;
}
```

### Decision Engine

```typescript
type LoopDecision =
  | { action: 'publish'; reason: string }
  | { action: 'iterate'; reason: string; findings: ReviewFinding[] }
  | { action: 'block'; reason: string }
  | { action: 'error'; reason: string };

/** Determine next action based on review verdict, verify results,
 *  and iteration counts.
 *
 *  Rules:
 *  1. APPROVED + verify pass → publish
 *  2. APPROVED + verify fail → iterate (fix verify failures)
 *  3. CHANGES_REQUIRED + under limit → iterate
 *  4. CHANGES_REQUIRED + at limit → block
 *  5. BLOCKED → block
 *  6. Parse failure + blockOnAmbiguousReview → block
 *  7. Parse failure + !blockOnAmbiguousReview → iterate (one more try)
 *  8. Cost limit exceeded → block
 *  9. Max iterations reached → block */
function decide(ctx: RunContext, loopConfig: LoopConfig): LoopDecision;
```

### Cost Tracking

```typescript
interface CostTracker {
  /** Record estimated cost for a worker invocation. */
  recordCost(runId: string, costUsd: number): void;

  /** Get total cost for today. */
  getDailyCost(): number;

  /** Get cost for a specific run. */
  getRunCost(runId: string): number;

  /** Check if daily or per-run limit is exceeded. */
  isOverBudget(runId: string, limits: SecurityConfig): boolean;
}
```

### Phase Checkpointing

```typescript
interface Checkpoint {
  /** Save phase start to DB. */
  phaseStarted(runId: string, phase: LoopPhase): void;

  /** Save phase completion with artifacts to DB. */
  phaseCompleted(
    runId: string,
    phase: LoopPhase,
    artifacts: Record<string, unknown>
  ): void;

  /** Get last completed phase for a run (for crash recovery). */
  getLastCompleted(runId: string): { phase: LoopPhase; artifacts: Record<string, unknown> } | null;

  /** Resume a run from its last checkpoint.
   *  Returns a RunContext with state restored from DB. */
  resumeFromCheckpoint(runId: string): RunContext | null;
}
```

### Diff-Size Guard

```typescript
interface DiffStats {
  changedFiles: number;
  insertions: number;
  deletions: number;
  totalChangedLines: number;
}

/** Check diff size against configured limits.
 *  Run before commit to prevent oversized changes. */
function checkDiffSize(
  worktreePath: string,
  limits: { maxChangedFiles: number; maxChangedLines: number }
): Promise<{ ok: boolean; stats: DiffStats; reason: string | null }>;
```

---

## Config Schema Additions

No new fields — uses existing config:

```yaml
loop:
  maxReviewIterations: 4
  maxTotalAgentPasses: 10
  stopOnPlannerFailure: true
  requireVerificationPass: true
  reviewApprovalKeyword: APPROVED
  reviewNeedsChangesKeyword: CHANGES_REQUIRED
  blockOnAmbiguousReview: true

security:
  maxChangedFiles: 50
  maxChangedLines: 5000
  maxDailyCostUsd: 50
  maxCostPerRunUsd: 10
```

---

## Files to Create

```
src/
  loop/
    types.ts               — RunContext, LoopPhase, PhaseRecord, LoopDecision
    engine.ts              — LoopEngine: orchestrates the full loop
    context.ts             — RunContext creation, update helpers (immutable updates)
    planner.ts             — thin coordinator: compile prompt → call worker → parse result
    coder.ts               — thin coordinator: compile prompt → call worker → parse result
    reviewer.ts            — thin coordinator: compile prompt → call worker → parse result
    verifier.ts            — Verifier: run verify commands via execa
    decision.ts            — decide() function
    checkpoint.ts          — Phase checkpointing in SQLite
    cost.ts                — CostTracker using daily_costs table
    diff-guard.ts          — checkDiffSize() via git diff --stat
    commit.ts              — git add, commit with standard message format
```

### File Descriptions

- **`loop/types.ts`**: All loop-related types. `RunContext`, `LoopPhase`, `PhaseRecord`, `LoopDecision`, `VerifyResult`.
- **`loop/engine.ts`**: The heart of the system. Implements the state machine:
  1. PLAN → CODE → VERIFY → REVIEW → DECISION
  2. If DECISION = iterate → CODE → VERIFY → REVIEW → DECISION
  3. If DECISION = publish → hand off to Phase 6
  4. If DECISION = block/error → update run, return
  Each step calls checkpoint before/after. Checks cost limits before each agent pass.
- **`loop/context.ts`**: Factory for `RunContext`, plus `updateContext(ctx, patch)` that returns a new immutable context. Ensures `RunContext` is always consistent.
- **`loop/planner.ts`**: Thin coordinator. Compiles planner prompt from context, calls worker adapter, parses result, returns updated context with plan. If `stopOnPlannerFailure` and planner fails, returns context with `error` phase.
- **`loop/coder.ts`**: Thin coordinator. Compiles coder prompt (includes plan + review findings), calls worker adapter, parses result. Does NOT run verify — that's separate.
- **`loop/reviewer.ts`**: Thin coordinator. Compiles reviewer prompt (includes plan + diff + verify results), calls worker adapter, parses verdict. Logs raw output for debugging.
- **`loop/verifier.ts`**: Runs configured verify commands sequentially via `execa` in the worktree. Each command gets a timeout (60s default). Captures stdout/stderr. Returns all results even if some fail.
- **`loop/decision.ts`**: Pure function. Takes `RunContext` + `LoopConfig`, returns `LoopDecision`. Implements the 9 decision rules documented above. Thoroughly tested.
- **`loop/checkpoint.ts`**: Writes phase transitions to `runs.current_phase` and `runs.phase_data` (JSON). On startup, `resumeFromCheckpoint` reads last state and reconstructs `RunContext`. Artifacts stored: plan output, verify results, review verdict.
- **`loop/cost.ts`**: Updates `daily_costs` table and `runs.estimated_cost_usd`. Currently estimates based on duration (refined when token usage is available). `isOverBudget` checks both daily and per-run limits.
- **`loop/diff-guard.ts`**: Runs `git diff --stat` in worktree, parses output, compares against `security.maxChangedFiles` and `security.maxChangedLines`. If exceeded, returns `ok: false` with reason.
- **`loop/commit.ts`**: `git add -A && git commit -m "night-orch: implement #<issue> <title>"` in worktree. Runs diff-guard before committing. If diff-guard fails, skips commit and returns error context.

---

## Loop Execution Flow

```
execute(ctx):
  1. checkpoint.phaseStarted(ctx.runId, 'plan')
  2. ctx = await planStep(ctx)
  3. checkpoint.phaseCompleted(ctx.runId, 'plan', { plan: ctx.plan })
  4. if plan failed && stopOnPlannerFailure → return ctx with 'error'

  ITERATION LOOP:
  5. if costTracker.isOverBudget → return ctx with 'blocked'
  6. checkpoint.phaseStarted(ctx.runId, 'code')
  7. ctx = await codeStep(ctx)
  8. checkpoint.phaseCompleted(ctx.runId, 'code', { codeResult: ctx.codeResult })

  9. checkpoint.phaseStarted(ctx.runId, 'verify')
  10. ctx = await verifyStep(ctx)
  11. checkpoint.phaseCompleted(ctx.runId, 'verify', { verifyResults: ctx.verifyResults })

  12. checkpoint.phaseStarted(ctx.runId, 'review')
  13. ctx = await reviewStep(ctx)
  14. checkpoint.phaseCompleted(ctx.runId, 'review', { reviewResult: ctx.reviewResult })

  15. decision = decide(ctx, loopConfig)
  16. switch(decision.action):
      'publish' → diffGuard check → commit → return ctx with 'completed'
      'iterate' → ctx.iteration++ → goto 5
      'block'   → return ctx with 'blocked'
      'error'   → return ctx with 'error'
```

### Crash Recovery Flow

On startup (or `run-once`):
1. Check for runs with `status = 'running'` that have checkpoints
2. For each: `resumeFromCheckpoint(runId)` reconstructs context
3. Resume from last completed phase (e.g., if plan completed, start at code)
4. If no checkpoint data, restart from plan

---

## Tests

### RunContext Tests (`test/loop/context.test.ts`)
- Create initial context with all required fields
- `updateContext` returns new object, original unchanged
- Phase history accumulates correctly

### Decision Engine Tests (`test/loop/decision.test.ts`)
- APPROVED + all verify pass → publish
- APPROVED + verify fail → iterate
- CHANGES_REQUIRED + under limit → iterate with findings
- CHANGES_REQUIRED + at max iterations → block
- BLOCKED verdict → block immediately
- Parse failure + blockOnAmbiguousReview → block
- Parse failure + !blockOnAmbiguousReview → iterate (one retry)
- Cost over budget → block
- Max total agent passes reached → block
- Combined: APPROVED but cost exceeded → block (cost wins)

### Verifier Tests (`test/loop/verifier.test.ts`)
- All commands pass → `allPassed` true
- One command fails → `allPassed` false, all results returned
- Command timeout → treated as failure
- Empty command list → pass (vacuously true)
- Command stderr captured even on success

### Loop Engine Tests (`test/loop/engine.test.ts`)
- Happy path: plan → code → verify pass → review APPROVED → completed
- Review bounce: CHANGES_REQUIRED → code → verify → review APPROVED → completed
- Max iterations: 4 bounces → blocked
- Planner failure + stopOnPlannerFailure → error
- Planner failure + !stopOnPlannerFailure → skip to code
- Cost limit hit mid-loop → blocked

### Checkpoint Tests (`test/loop/checkpoint.test.ts`)
- Phase start/complete records in DB
- `getLastCompleted` returns correct phase
- `resumeFromCheckpoint` reconstructs context with plan from DB
- Run with no checkpoints returns null

### Diff Guard Tests (`test/loop/diff-guard.test.ts`)
- Under limits → ok
- Over `maxChangedFiles` → not ok with reason
- Over `maxChangedLines` → not ok with reason
- No changes → ok (empty diff)

### Cost Tracker Tests (`test/loop/cost.test.ts`)
- Record cost increments daily total
- Per-run cost tracked independently
- `isOverBudget` checks both limits
- Daily cost resets for new date

### Integration Test (`test/loop/full-loop.test.ts`)
- Mock workers: planner returns plan, coder succeeds, reviewer approves
- Full loop executes and returns completed context
- Verify commands actually run (use simple `true`/`false` commands)
- Checkpoint data persists across simulated crash (stop + resume)

---

## Acceptance Criteria

1. Loop executes PLAN → CODE → VERIFY → REVIEW → DECISION correctly
2. `RunContext` is threaded immutably through all steps
3. Reviewer can bounce back to coder with findings (up to `maxReviewIterations`)
4. Loop stops at `maxTotalAgentPasses` even if review keeps requesting changes
5. Phase checkpoints written to DB before/after each phase
6. Crash recovery resumes from last completed phase
7. Cost tracker prevents exceeding daily and per-run limits
8. Diff-size guard flags oversized changes before commit
9. Verify commands run by orchestrator (not trusted from agent output)
10. `--dry-run` mode executes discovery but skips agent invocations
11. All tests pass: `pnpm test`
