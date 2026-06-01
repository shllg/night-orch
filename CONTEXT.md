# night-orch

Background orchestrator that drives AI workers (Claude, Codex) through plan → code → review → verify loops on GitHub/Forgejo issues, opens PRs, and keeps the work moving while a human is AFK.

## Language

**Run**:
A single tracked unit of work for one issue — owns a branch, an attempt chain, and a status (`queued | running | review_ready | blocked | error | completed`).
_Avoid_: Job, task, ticket.

**Attempt**:
One execution of the loop within a run. A run accumulates a chain of attempts when retries, follow-ups, or rebases occur; chain length is capped by `loop.maxAttemptChainLength`.
_Avoid_: Try, iteration.

**Intent**:
The reason an attempt was created. Examples: `initial`, `retry`, `rebase`, `continue`. Carried on the attempt row, used to specialize prompts and labels.
_Avoid_: Mode, purpose.

**Phase**:
A step inside one attempt's loop — `plan`, `code`, `verify`, `review`. Each phase writes a checkpoint to the DB for crash recovery.
_Avoid_: Stage, step.

**Source PR**:
A pull request whose merge into the base branch triggers a **merge fan-out** for its siblings.
_Avoid_: Parent PR, upstream PR.

**Sibling PR**:
An open PR tracked by night-orch in the same repo and targeting the same base branch as a recently-merged **source PR**. Sibling PRs are the fan-out targets.
_Avoid_: Peer PR, neighbour PR.

**Merge fan-out**:
The automatic event where merging a source PR queues a rebase **attempt** (intent `rebase`) for each qualifying sibling PR. Gated by per-repo `autoRebaseOnMerge.enabled`.
_Avoid_: Cascade, rebase wave.

**Forge**:
Abstraction over GitHub/Forgejo. All hosted-git calls route through `ForgeAdapter` — direct Octokit usage outside `forge/github.ts` or `forge/forgejo.ts` is forbidden.
_Avoid_: Provider, host, remote.

**Worker**:
An AI subprocess (Claude CLI or Codex CLI) invoked for one phase, with a strictly-whitelisted env (no tokens). Output is parsed and validated before acting on it.
_Avoid_: Agent, model, executor.

**Lease**:
A short-lived DB-backed exclusive claim on an issue that prevents two engines from processing it concurrently. Heartbeated during long phases; auto-released when stale.
_Avoid_: Lock, mutex.

**Verify**:
The phase that runs project-defined commands (typecheck, lint, test) inside the worktree. Distinct from **review** (AI critique of the diff).
_Avoid_: Validate, check.

**Checkpoint**:
A row written at phase start/complete used to resume an incomplete run after a crash. Stored per attempt.
_Avoid_: Snapshot, savepoint.

## Example dialogue

> **Dev:** "PR #42 just merged into `develop`. Now what?"
>
> **Domain expert:** "If `autoRebaseOnMerge.enabled` is on for that repo, #42 is the **source PR** for a **merge fan-out**. The sync poller spots the `merged` state, finds every open **sibling PR** targeting `develop` that night-orch tracks, and queues a new **attempt** with `intent: 'rebase'` on each."
>
> **Dev:** "What if a sibling is already running?"
>
> **Domain expert:** "Skipped. The filter excludes runs in `running` or `queued` status, and refuses to stack a second rebase attempt on top of an in-flight one. The fan-out is idempotent — the `rebase_fanouts` table keys on `(repo, source_pr_number)`."
>
> **Dev:** "So the worker reruns the whole loop?"
>
> **Domain expert:** "Not necessarily. The poller picks up the queued rebase attempt, runs `executeRebase` to rebase the branch onto latest base, and runs the **verify** phase. Only if verify fails does it kick off a full code → verify → review cycle to fix the breakage."
