# Night-Orch Implementation Specs

## Phase Status

All 11 phases are implemented. Remaining gaps (missing source, features, and known issues) are consolidated in [remaining-work.md](remaining-work.md).

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Skeleton CLI + Config + State | Complete |
| 2 | Forge Adapter + Issue Discovery + Leasing | Complete |
| 3 | Git Worktree + Branch + Environment | Complete |
| 4 | Worker Adapters + Triage + Sandboxing | Complete (minor env export gap) |
| 5 | Loop Engine + Verification + Guardrails | Complete (missing `resumeFromCheckpoint`) |
| 6 | PR/MR Publication + Label Management | Complete (edge cases, attribution footer) |
| 7 | Notifications + PR Mentions | Complete |
| 8 | Sync + Cleanup + Retry + Polish | ~30% — largest remaining gap |
| 9 | Prometheus Metrics + Observability | Complete (missing Grafana dashboard, integration wiring) |
| 10 | MCP Server Layer | Complete (missing `list-issues` tool) |
| 11 | Forgejo Adapter | Complete (minor gaps: nodeId, doctor, timeouts) |

## Reference Documents
- Remaining work: [remaining-work.md](remaining-work.md)
- Full specification: `/home/sascha/Downloads/nightly-orchestrator-plan.md`
