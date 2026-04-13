# Night-Orch Implementation Specs

## Phase Status

All 11 phases are implemented. Remaining gaps are consolidated in [remaining-work.md](remaining-work.md).

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Skeleton CLI + Config + State | Complete |
| 2 | Forge Adapter + Issue Discovery + Leasing | Complete |
| 3 | Git Worktree + Branch + Environment | Complete |
| 4 | Worker Adapters + Triage + Sandboxing | Complete |
| 5 | Loop Engine + Verification + Guardrails | Complete |
| 6 | PR/MR Publication + Label Management | Complete |
| 7 | Notifications + PR Mentions | Complete |
| 8 | Sync + Cleanup + Retry + Polish | Complete |
| 9 | Prometheus Metrics + Observability | Complete (Grafana dashboard pending) |
| 10 | MCP Server Layer | Complete |
| 11 | Forgejo Adapter | Complete (merge-queue methods pending) |

## Reference Documents
- Remaining work: [remaining-work.md](remaining-work.md)
- File-loop maintenance mode: [file-loop-prd.md](file-loop-prd.md)
