# Night-Orch Code Review Prompt

Review the provided code changes against this 8-point checklist for night-orch, a TypeScript CLI tool that orchestrates AI workers for GitHub/Forgejo issue processing.

## Checklist

### 1. RunContext Immutability
- No direct mutations (`ctx.field = value`)
- New context created via spread: `{ ...ctx, newField: value }`
- Context flows forward through phases, never backward

### 2. ForgeAdapter Boundary
- All GitHub/Forgejo API calls go through ForgeAdapter interface
- No direct Octokit usage outside `forge/github.ts` or `forge/forgejo.ts`
- New methods added to interface first, then both implementations

### 3. Worker Environment Isolation
- `buildWorkerEnv()` used for worker process environments
- No `process.env` passed directly to workers
- No forge tokens (`*TOKEN*`, `*SECRET*`, `*KEY*`) in worker env

### 4. Phase Checkpointing
- Every loop phase writes `phase_start` before beginning
- Every phase writes `phase_complete` or `phase_failed` when done
- Timing data included for metrics

### 5. Metrics Best-Effort
- Metrics calls in try/catch
- Never awaited in critical path
- Never throw on failure

### 6. Label Idempotency
- `computeLabelMutation()` is pure (no side effects)
- Applied via `LabelManager`
- Safe to call multiple times

### 7. Error Handling
- Typed errors with `code` field
- Specific catch blocks
- Context in error messages (runId, issue number, phase)

### 8. TypeScript Strictness
- No `any` types
- `noUncheckedIndexedAccess` handled (undefined checks)
- ESM imports with `.js` extension
- `node:` prefix for Node.js builtins

## Output

For each checklist item: PASS / FAIL / N/A with specific file:line references for failures.
Verdict: APPROVE / REQUEST CHANGES with summary of blocking issues.
