---
name: loop-engine
description: RunContext lifecycle, phase checkpoints, decide() logic, iteration flow, cost tracking
---

# Loop Engine Skill

The loop engine is the heart of night-orch. It processes issues through phases: plan → code → review → verify, with checkpointing for crash recovery.

## RunContext Lifecycle

```
Issue selected → RunContext created
  → plan phase (returns new ctx with planOutput)
    → code phase (returns new ctx with codeDiff)
      → review phase (returns new ctx with reviewResult)
        → verify phase (returns new ctx with verifyStatus)
          → decide() → continue/stop/retry
```

**Key rule**: NEVER mutate RunContext. Each phase receives context and returns a new one:

```typescript
function planPhase(ctx: Readonly<RunContext>): Promise<RunContext> {
  const planOutput = await planner.execute(ctx);
  return { ...ctx, planOutput, phase: 'plan_complete' };
}
```

## Phase Checkpointing

Every phase MUST checkpoint to the database:

```typescript
async function executePhase(ctx: RunContext, phase: string): Promise<RunContext> {
  await db.writeCheckpoint(ctx.runId, phase, 'started');
  try {
    const result = await doPhaseWork(ctx);
    await db.writeCheckpoint(ctx.runId, phase, 'completed');
    return result;
  } catch (error) {
    await db.writeCheckpoint(ctx.runId, phase, 'failed', { error: String(error) });
    throw error;
  }
}
```

On restart, the engine reads checkpoints and resumes from the last completed phase.

## `decide()` Function

Pure function — no I/O, no side effects:

```typescript
function decide(ctx: Readonly<RunContext>): Decision {
  // Check budget
  if (ctx.totalTokens > ctx.config.maxTokenBudget) {
    return { action: 'stop', reason: 'Token budget exceeded' };
  }
  // Check iteration limit
  if (ctx.iteration >= ctx.config.maxIterations) {
    return { action: 'stop', reason: 'Max iterations reached' };
  }
  // Check review result
  if (ctx.reviewResult?.approved) {
    return { action: 'stop', reason: 'Review approved' };
  }
  // Check for retriable errors
  if (ctx.lastError && ctx.retryCount < ctx.config.maxRetries) {
    return { action: 'retry', reason: ctx.lastError, delay: backoff(ctx.retryCount) };
  }
  return { action: 'continue', reason: 'Proceeding to next iteration' };
}
```

**Test exhaustively** — every branch, every edge case. This is where bugs cause infinite loops or premature stops.

## Cost Tracking

- Each worker call returns token counts (prompt + completion)
- Accumulate in RunContext: `{ ...ctx, totalTokens: ctx.totalTokens + usage.total }`
- `decide()` checks against budget before continuing
- Store final cost in DB for reporting

## Diff Guard

Before creating a PR, verify the diff is reasonable:
- Not empty (worker produced no changes)
- Not too large (exceeds configured max diff size)
- Doesn't touch files outside the expected scope
- Doesn't contain secrets or tokens

## When Working on Loop Code

1. Check the phase spec in `docs/specs-active/phase-05-loop.md`
2. Ensure RunContext immutability
3. Add checkpointing for any new phase
4. Keep `decide()` pure — extract I/O to callers
5. Add metrics (best-effort) for timing and token usage
