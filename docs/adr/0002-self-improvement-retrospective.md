# ADR 0002 — Self-improvement retrospective layer

## Status

Accepted (initial slice).

## Context

Night-orch runs the same workflows on different issues night after night. The same failure modes recur — vague plans, verify regressions, empty diffs, reviewer loops, auth drift. Today the engine reacts in real time (label transitions, reaction scanner, iterate jumps) but nothing reads back the long-tail signal across runs to improve the prompts that drive future work.

Item 3 of the "full-pipeline + timeline + retro" plan adds the data layer for a retrospective feedback loop: persist enough structured signal per run so a separate, explicit operation can mine it and surface concrete prompt-edit suggestions.

Two design decisions warrant a record:

1. How prompt bodies are stored without bloating the DB.
2. Why the loop never auto-rewrites prompt templates.

## Decisions

### 1. Content-addressed prompt storage

Every call to `compilePrompt()` records one row in `prompt_compilations` with SHA256 pointers into a dedup table `prompt_contents (sha PK, content TEXT)`. A bounded LRU on `getOrInsertContent` skips the SELECT for hot SHAs.

Rationale:
- Most runs share the same system prompt. A naive per-compilation copy bloats the DB by ~200 KB per run.
- Content-addressed storage makes future tooling (diffing prompt variants across runs) trivial — same SHA ⇒ same prompt.
- The LRU keeps the hot path off SQLite; the on-disk INSERT is `INSERT OR IGNORE` so concurrency is safe.

Risks accepted:
- Long-running deployments accumulate distinct SHAs forever. A retention policy (TTL pruning of `prompt_contents` rows not referenced by recent runs) is intentionally deferred to a future ADR.
- Per-table `id` is not globally unique across timeline sources — see the timeline composite sort `(ts, kindWeight, id)`.

### 2. No-auto-apply policy

`night-orch retro --apply <id>` writes the suggestion markdown to `.night-orch/retro/<id>.md` and stamps `applied_at` on the row. It never edits the target template file. The operator runs `git apply` (or edits manually) and commits.

Rationale:
- Prompt templates are version-controlled and load-bearing. A single bad suggestion auto-merged could degrade every subsequent run.
- The retro engine clusters signal; it does not have ground truth. Human review is the necessary safety net.
- The two-step apply gives operators a free rollback (don't commit) and a clear audit trail (`applied_via_commit_sha`).

### 3. Failure classifier is pure + structural

`classifyPhaseFailure(ctx, phaseRecord, decision?) → Classifier | null` is a pure function over the run context. It maps every `BlockReason` (14) to a classifier and infers three more from worker output shape (`context_exhaustion`, `tool_hallucination`, `rate_limit_provider`) plus three infrastructure modes (`provider_refusal`, `dependency_error`, `upstream_outage`).

The classifier does NOT call an LLM. Structural heuristics only — length checks, missing-keys, regex over `errorMessage`. The retro engine is the place for "vibes" interpretation, not the classifier.

### 4. Recursion guard via skipPromptLogging

The retro engine itself invokes a worker (role: `retro`). Without a guard, its own `compilePrompt()` calls would write to `prompt_compilations` and surface in the next retro window. Two layers of defense:

1. The retro engine sets `skipPromptLogging: true` in its compile context.
2. `listClassifiersSince` filters `phase != 'retro'` defensively.

### 5. Surface set: CLI + MCP (no TUI)

CLAUDE.md requires command parity across CLI + TUI + MCP for operational commands. `retro` is intentionally not surfaced in the TUI:

- TUI is the live operational dashboard ("Flight Radar").
- Retro is post-mortem analysis ("Flight Recorder").
- Mixing them clutters the operational view without an operational benefit.

The CLI provides `night-orch retro [--since 7d] [--dry-run] [--view <id>] [--apply <id>]`. MCP provides three tools: `night-orch-retro-run`, `night-orch-retro-list-suggestions`, `night-orch-retro-view-suggestion`. No MCP apply tool — apply requires human discretion at the terminal.

## What this ADR does NOT decide

- **Meta-agent worker invocation.** The current `runRetro()` implementation clusters classifiers and writes a placeholder suggestion documenting each cluster. The actual LLM-driven prompt-diff generation is a follow-up — the data layer + storage + CLI/MCP surface ships first so the prompt itself can be tuned against real data.
- **Retention.** `prompt_contents` grows unbounded over months. The pruning policy is a separate ADR.
- **Cross-repo suggestion sharing.** Suggestions are currently per-database. A future change could aggregate across repos via the suggestion's `source_run_ids_json`.

## Files

- `src/state/migrations/034-retro-tables.ts` — 4 tables: `prompt_contents`, `prompt_compilations`, `retro_classifiers`, `retro_suggestions`.
- `src/state/prompt-contents.ts` — SHA + LRU.
- `src/state/prompt-compilations.ts` — per-compile pointers.
- `src/state/retro.ts` — classifier + suggestion DB API.
- `src/loop/classifier.ts` — pure 17-category classifier.
- `src/loop/engine.ts` — calls classifier after each phase; passes `db` to step deps.
- `src/loop/step-executor.ts` — records prompt compilation when observability flag is on.
- `src/config/schema.ts` — `observability.recordPromptCompilations` toggle.
- `src/ops/retro.ts` — clustering + suggestion emission (placeholder content).
- `src/cli/commands/retro.ts` — CLI surface.
- `src/mcp/tools/retro.ts` — three MCP tools.
