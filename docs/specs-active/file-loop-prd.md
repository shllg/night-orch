# File-Loop Maintenance Mode

## Goal

Add an explicit repo-scoped maintenance loop that can make small, low-risk cleanup improvements while a repository is otherwise idle, without competing with issue-driven orchestration.

## Operator Model

Operators start a file-loop session manually through CLI, MCP, or the TUI. The session is attached to one configured repo and runs until one of these terminal conditions is reached:

- manual stop
- max duration reached
- cost budget reached
- no eligible files remain
- unrecoverable publication/finalization error

Only one active file-loop session may exist per repo at a time.

## Core Behavior

1. Create or resume a dedicated `file-loop` worktree and branch for the repo.
2. Advance only when the repo has no active issue runs.
3. Select the next eligible file using glob filters, file-size limits, and prior file-loop state.
4. Ask the configured reviewer profile to classify the file and propose edits.
5. Apply edits only when the response is classified as `trivial`.
6. Run per-edit verification after each applied edit.
7. Record non-trivial follow-up work in `loop.md` instead of auto-editing the target file.
8. On finalization, run final verification and publish one PR when commits exist.

## Safety Rules

- Never mutate the user's main clone directly; use a managed worktree.
- Never run while normal issue work is active for the same repo.
- Never auto-apply changes classified above `trivial` difficulty.
- Never trust worker claims about verification; the orchestrator runs verification commands itself.
- Preserve deferred work in `loop.md` so larger refactors are visible instead of silently skipped.

## Config Surface

Top-level `fileLoop` defines defaults for all repos. `repos[].fileLoop` provides per-repo overrides. Key controls:

- `enabled`
- `maxDurationMinutes`
- `maxIterations`
- `minIntervalSecondsBetweenFiles`
- `perIterationTimeoutSeconds`
- `maxCostUsd`
- `maxFileLines`
- `includeGlobs` / `excludeGlobs`
- `reviewerProfileKey`
- `branchNameTemplate`
- `loopMdPath`
- `commitPrefix`
- `perEditVerify`
- `finalizeVerify`

## User Surfaces

- CLI: `night-orch file-loop start|stop|status`
- MCP: `night-orch-file-loop`
- TUI: File-Loop tab with start/stop actions
- Poller: active sessions continue to tick during normal poll cycles even when no issues are discovered

## Persistence

SQLite stores:

- session lifecycle and totals
- per-file history and last outcome
- active/finalized status for crash-safe restart behavior

## Publication

File-loop publication reuses the forge adapter and PR publication flow. If final verification fails, `finalizeVerify.onFailure` controls whether night-orch opens a draft PR anyway or suppresses PR creation.
