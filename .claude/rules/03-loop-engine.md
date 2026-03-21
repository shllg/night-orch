# Loop Engine Rules

Applies to: `src/loop/**`, `src/workers/**`

## RunContext Lifecycle

1. `RunContext` created at loop start with issue data, config, branch info
2. Each phase (plan → code → review → verify) receives context, returns new context
3. Context accumulates: plan output → code diff → review result → verify status
4. NEVER mutate — always spread and extend: `{ ...ctx, planOutput: result }`

## Phase Checkpointing

Every phase MUST:
1. Write `phase_start` to DB before beginning work
2. Write `phase_complete` (or `phase_failed`) to DB when done
3. Include timing data for metrics
4. On crash recovery, the engine reads checkpoints to resume from the last completed phase

## `decide()` Function

- Pure function: `(ctx: RunContext) => Decision`
- No side effects, no I/O, no DB access
- Must be exhaustively tested — every branch, every edge case
- Returns discriminated union: `{ action: 'continue' | 'stop' | 'retry', reason: string }`

## Prompt/Parser Separation

- Prompt compilation lives in `workers/prompt/` — assembles system + user prompts from templates
- Output parsing lives in `workers/parsers/` — validates and extracts structured data from worker responses
- Loop coordinators (`planner.ts`, `coder.ts`, `reviewer.ts`) are thin wrappers — they call prompt, send to worker, call parser

## Metrics

- All metrics calls are best-effort: wrap in try/catch, never await, never throw
- Track: phase duration, worker token usage, loop iterations, error counts
- Use `metrics.inc*()` for counters, `metrics.observe*()` for histograms

## Label Idempotency

- `computeLabelMutation()` is a pure function: `(current: string[], desired: string[]) => { add: string[], remove: string[] }`
- Apply via `LabelManager` which handles forge API calls
- Safe to call multiple times — produces same result

## Cost Tracking

- Track token usage per worker call (prompt + completion tokens)
- Accumulate per-run cost in RunContext
- Check against budget limits in `decide()` before continuing
