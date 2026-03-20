# Night-Orch Implementation Specs

## Dependency Graph

```
Phase 1: Skeleton CLI + Config + State
  └─► Phase 2: Forge Adapter + Issue Discovery + Leasing
       └─► Phase 3: Git Worktree + Branch + Environment Management
            └─► Phase 4: Worker Adapters + Triage + Sandboxing
                 └─► Phase 5: Loop Engine + Verification + Guardrails
                      └─► Phase 6: PR/MR Publication + Label Management
                           └─► Phase 7: Notifications + PR Mentions
                                └─► Phase 8: Sync + Cleanup + Polish
Phase 9: Prometheus Metrics + Observability (after Phase 1, parallel with 2-8)
Phase 10: MCP Server Layer (after Phase 8)
Phase 11: Forgejo Adapter (after Phase 2)
```

## Phase Status

| Phase | Spec | Status | Dependencies |
|-------|------|--------|-------------|
| 1 | [phase-01-skeleton.md](phase-01-skeleton.md) | Pending | None |
| 2 | [phase-02-discovery.md](phase-02-discovery.md) | Pending | Phase 1 |
| 3 | [phase-03-worktree.md](phase-03-worktree.md) | Pending | Phase 2 |
| 4 | [phase-04-workers.md](phase-04-workers.md) | Pending | Phase 3 |
| 5 | [phase-05-loop.md](phase-05-loop.md) | Pending | Phase 4 |
| 6 | [phase-06-publishing.md](phase-06-publishing.md) | Pending | Phase 5 |
| 7 | [phase-07-notifications.md](phase-07-notifications.md) | Pending | Phase 6 |
| 8 | [phase-08-ops.md](phase-08-ops.md) | Pending | Phase 7 |
| 9 | [phase-09-metrics.md](phase-09-metrics.md) | Pending | Phase 1 |
| 10 | [phase-10-mcp.md](phase-10-mcp.md) | Pending | Phase 8 |
| 11 | [phase-11-forgejo.md](phase-11-forgejo.md) | Pending | Phase 2 |

## Cross-Cutting Concerns (from agent review)

These apply to ALL phases and were identified by the planning team:

### Security (Critical)
- **Worker env isolation**: Never pass full `process.env` to workers. Whitelist only required vars. Never pass `GITHUB_TOKEN` to workers.
- **Prompt injection**: Issue content is attacker-controlled. Sanitize before prompt compilation. Load config/prompts only from trusted paths, not from the repo being processed.
- **Token redaction**: Configure pino `redact` for `['*.token', '*.apiKey', '*.secret']`.

### Reliability (Critical)
- **Agent timeouts**: Every worker invocation must have `workerTimeoutSeconds` (default: 1800). Kill process group on timeout.
- **Cost circuit breakers**: `maxDailyCostUsd` and `maxCostPerRunUsd` config. Pause all runs when exceeded.
- **Phase checkpointing**: Before each loop phase, write `phase_started` to DB. After, write `phase_completed` with artifacts. On restart, resume from last completed phase.
- **Crash recovery**: On startup, run `sync` to reconcile stale `orch:running` labels and expired leases.
- **Diff-size guard**: Before commit, check `git diff --stat`. If changes exceed `maxChangedFiles`/`maxChangedLines`, flag as `orch:needs-human`.

### Design Patterns
- **`RunContext`**: Thread a typed context object through every loop step: `(ctx: RunContext) → Promise<RunContext>`. Pure, testable, easy to log.
- **Slug pinning**: Derive branch slug from issue title on first run, store in DB. Don't re-derive if title changes.
- **Serial only in v1**: Process one issue at a time. Defer concurrency to v1.5.
- **`--dry-run` flag**: Available from Phase 1. Discovers issues, shows what would happen, but doesn't mutate GitHub or run agents.
- **Loop coordinators**: `loop/planner.ts` etc. are thin coordinators that call `workers/` adapters. Keep prompt compilation and output parsing in `workers/`.

## Reference Documents
- Full specification: `/home/sascha/Downloads/nightly-orchestrator-plan.md`
- Implementation plan: `~/.claude/plans/fizzy-weaving-breeze.md`
- Vendis worktree reference: `~/src/vendis/vendis/bin/worktree`
