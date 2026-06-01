# Auto-rebase fan-out on merge

When a tracked PR merges into its base branch, night-orch automatically queues a rebase attempt for every open sibling PR (same repo, same base, tracked, non-terminal). Detection runs in the existing sync poll cycle and the merge-queue runner — no webhooks. Per-repo opt-in via `autoRebaseOnMerge.enabled`.

## Status

Accepted.

## Considered alternatives

- **Webhooks.** Rejected. Night-orch is a pull-based daemon; introducing an HTTP listener adds deployment surface and breaks the "run anywhere a poll can reach" property. Sync cadence is acceptable for the use case.
- **New `rebasing` RunStatus.** Rejected. Would force a schema migration plus updates to every `case` in `transitions.ts` and every sync reconciliation rule. Reusing `queued → running` with an optional `labels.rebasing` field gives the visual signal at much lower cost.
- **Global config (top-level `autoRebaseOnMerge`).** Rejected. Closest sibling concept (`mergeQueue`) is per-repo, and policy differs by repo (linear-merge repos want this off). Per-repo opt-in aligns.
- **Exempt fan-out attempts from `maxAttemptChainLength`.** Rejected. Silent unbounded chaining masks divergent branches that genuinely need a human. Instead, expose `autoRebaseOnMerge.maxChainLength` (defaults to 2× the normal cap) and surface exhaustion via a PR comment.
- **Fire only from merge-queue path.** Rejected. Direct-merge repos would get nothing. Calling the fan-out helper from both `sync.ts` merge transitions and `merge-queue/runner.ts:transitionMergedRuns` covers both.

## Consequences

- Depends on sync polling cadence — fan-out latency is bounded by `runner.pollIntervalSeconds`.
- v1 only fans out for **bot-tracked** source PRs. Human-merged PRs on a tracked base branch will not trigger fan-out (deferred — would require a forge-wide "merged since cursor" scan).
- Busy base branches can still exhaust the (raised) attempt chain cap; the exhaustion comment is the human-intervention signal.
- Idempotency lives in a new `rebase_fanouts(repo, source_pr_number)` table written **after** the fan-out loop finishes, so a crash mid-loop re-runs cleanly on the next cycle.
