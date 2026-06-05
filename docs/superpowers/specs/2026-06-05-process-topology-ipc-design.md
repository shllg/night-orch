# Process Topology + IPC Contract Design

**Date:** 2026-06-05
**Status:** Design — pending plan
**Scope:** Process boundaries, IPC transport, package layout. **Out of scope (follow-up specs):** staged-update FSM, config hot-reload apply matrix, auth model details.

## Problem

Night-orch is a single process today. The supervisor (`src/supervisor/`) forks `run` and `web` children but they share build, deploy, and crash blast radius. We want:

1. **Graceful crash recovery**: web restart must not interrupt running jobs.
2. **Staged hot-update**: maintenance banner → engine swap → web swap → resume, without losing in-flight runs that have checkpointed.
3. **Per-project config hot-reload**: detect orch.yml changes, apply without restart where possible.
4. **Shared TypeScript types** between processes (no copy-paste drift).
5. Independent TUI process that talks to the engine via HTTP, so it can run on a separate host.

## Non-goals

- Multi-host backend distribution.
- Plugin / third-party process model.
- Replacing the existing engine, DB, or worker layers.
- Rewriting in another language.

## Decisions

### D1. Process topology

```
runner (supervisor — pid 1 within the night-orch process group)
 ├── backend  (engine + DB + poller + workers + public HTTP api + MCP)
 └── web      (SPA static + reverse-proxy to backend api) — conditional via --no-web

external processes (not children of runner):
  tui     — `night-orch tui` HTTP client of backend api
  browser — talks to web (which reverse-proxies to backend)
  mcp     — MCP clients connect to backend's MCP HTTP transport
```

**runner**: pure supervisor. Forks children, monitors `/health`, restarts with exponential backoff (existing `src/supervisor/` pattern, expanded). Owns staged-update FSM. Watches its own topology config (which children to spawn, ports, flags). **No DB, no domain logic, no auth.** Target ≤ 800 LOC.

**backend**: sole owner of SQLite (WAL). Runs engine, poller, workers, lease coord, checkpoints, cost tracking, config hot-reload. Exposes a single public HTTP server (bind host/port from config) that serves:
- REST api at `/api/*` — auth-gated.
- SSE stream at `/api/events` — auth-gated.
- MCP transport at `/mcp/*` (when enabled) — separate auth.
- `/health` — unauthenticated, returns process health + queue depth.

**web**: static SPA + reverse-proxy. Serves built React assets and proxies `/api/*` + `/api/events` to backend. Conditional (`config.web.enabled`). Crash is harmless — engine + MCP + TUI unaffected.

**tui**: HTTP client of backend api. Lives in `cli/src/tui/` folder, dispatched by `night-orch tui` subcommand. Same auth, same API surface as web SPA.

### D2. IPC transport

| Edge | Transport | Auth | Rationale |
|------|-----------|------|-----------|
| runner ↔ child | `node:child_process.fork` IPC + `/health` HTTP | none (loopback, PID-bound) | Existing pattern, debuggable, supports structured messages over `process.send`. |
| browser ↔ web | HTTP/HTTPS | bearer cookie | Standard browser. |
| web ↔ backend | HTTP loopback reverse-proxy | bearer token forwarded | Web is dumb proxy; backend is single auth boundary. |
| tui ↔ backend | HTTP REST + SSE | bearer token | Same surface as web SPA — zero divergence. |
| MCP client ↔ backend | HTTP (streamable transport) | MCP auth (existing) | Reuse `src/mcp/http.ts`. |

**Why HTTP everywhere on the data plane:** existing infra (pino, zod, auth middleware) is reusable; loopback latency is sub-millisecond; portable to remote-TUI scenarios; debuggable with curl. Unix sockets and message queues add complexity we do not need.

**Runner ↔ child control plane** uses Node's built-in fork IPC for structured commands (drain, stop, status) plus an HTTP health probe per child. This matches what `src/supervisor/index.ts` already does and avoids inventing a new wire format.

### D3. Maintenance flag

The runner owns the maintenance flag in memory and pushes it to backend via the fork IPC channel. Backend then echoes it on `/health` and on SSE. Web SPA and TUI read maintenance state from SSE and show a banner; clients may continue read-only operations but write endpoints reject with `503 maintenance`.

### D4. Package split (pnpm workspace)

Day-1 packages (must exist after migration):

```
packages/
  shared/     @night-orch/shared    types + zod schemas + pure logic (decide, parsers, label mutation, prompt compile) + shared constants
  backend/    @night-orch/backend   engine, DB, forge, workers, HTTP api, MCP, config hot-reload
  web/        @night-orch/web       SPA build + static server + reverse-proxy
  runner/     @night-orch/runner    supervisor (replaces src/supervisor/)
  cli/        night-orch            thin entry: parses argv, dispatches to runner/tui/one-shot cmds
                                    (tui lives here as src/tui/, no separate pkg yet)
```

- `shared` is the only leaf; everyone may depend on it. It depends on `node:*` + `zod` only — no internal deps.
- `backend`, `web`, `runner` depend on `shared`.
- `cli` is the published bin; internal packages are `"private": true` initially.
- TS project references for incremental builds.
- pnpm workspace with `packages/*` glob.

Deferred package extractions (folder inside an existing package today, separate package when the boundary stabilizes):

- `tui` — currently lives in `src/cli/tui/`; lift to `packages/tui/` when its API surface stops churning.
- `api` — kept inside `backend` package (api is a thin HTTP gateway over engine; extracting it gains no isolation but adds a publish artifact).

### D5. Shared package (`@night-orch/shared`)

Contents:

- **Domain models**: `Run`, `RunPhase`, `Issue`, `WorkItem`, `Lease`, `CostBucket`, `Checkpoint`, `Project`, `Repository`.
- **IPC envelopes**: `ApiRequest<T>`, `ApiResponse<T>`, `ApiError`, `SseEvent<T>` discriminated union.
- **Health**: `HealthStatus`, `ProcessName`, `UpdatePhase`, `MaintenanceState`.
- **Config**: zod schemas + inferred types for app config and project config.
- **Runner control messages**: `RunnerCommand` (drain, stop, set-maintenance, reload-config), `RunnerEvent` (child-up, child-down, child-health).
- **Pure logic**: `decide`, `computeLabelMutation`, worker output parsers, prompt compilers. Anything I/O-free.
- **Shared constants**: SSE event names, error codes, default ports.

Purity enforced by ESLint rule (`no-restricted-imports`): `shared` cannot import `better-sqlite3`, `@octokit/*`, `execa`, `chokidar`, `pino`, `node:fs`, `node:net`, `node:http`, or any other internal package. Only `node:url` / `node:path` style pure utilities + `zod` allowed.

### D6. Auth

- **Backend public HTTP**: bearer token in `Authorization: Bearer <token>`. Token from `<dataDir>/auth.token` (chmod 600, generated at first start). Same token for TUI and web SPA (forwarded by reverse-proxy). Remote TUI usage requires the operator to copy the token out of band; multi-user / scoped tokens are out of scope here (see follow-up specs).
- **MCP**: existing MCP auth, unchanged.
- **Runner → child fork IPC**: PID-bound, no extra auth.
- **`/health`**: unauthenticated.

Token rotation, scoped tokens, and multi-user auth are follow-up work — out of scope here.

### D7. Crash + recovery matrix

| Crash | Effect | Recovery |
|-------|--------|----------|
| backend | tui/web get 5xx, MCP clients disconnect, in-flight workers receive SIGTERM | runner respawns, engine reads checkpoints, resumes runs from last completed phase. Workers re-run from phase boundary. |
| web | browser broken; tui + MCP + jobs unaffected | runner respawns; browser reconnects via SSE retry. |
| runner | children become orphans; each child polls PPID, exits if runner gone | external supervisor (systemd, launchd, docker) restarts runner, runner respawns children. |

### D8. Health endpoints

Every child exposes `GET /health` returning:

```json
{
  "status": "ok" | "degraded" | "draining" | "down",
  "version": "0.20.0",
  "process": "backend" | "web",
  "uptime_seconds": 12345,
  "maintenance": false,
  "details": {
    "db": "ok",          // backend only
    "queueDepth": 3,     // backend only
    "activeRuns": 2      // backend only
  }
}
```

Runner polls every 5s with a 5s timeout. Three consecutive failures → restart.

### D9. Backend HTTP api surface

The backend public HTTP exposes (full schema lives in `@night-orch/shared`):

- `GET /api/runs` — list runs (paginated, filterable).
- `GET /api/runs/:id` — run detail incl. checkpoints + cost.
- `POST /api/runs/:id/retry` — retry a failed run.
- `DELETE /api/runs/:id` — cancel an active run.
- `GET /api/issues` — list discovered issues.
- `POST /api/issues/:id/loop` — manual loop trigger.
- `GET /api/settings` — list runtime settings.
- `POST /api/settings` — set a runtime setting.
- `GET /api/costs` — cost report.
- `GET /api/events` — SSE stream of `RunEvent`, `IssueEvent`, `HealthEvent`, `MaintenanceEvent`.
- `GET /health` — see D8.
- `/mcp/*` — MCP HTTP transport (existing).

This is approximately the current `src/web/routes/*` surface, formalized in `@night-orch/shared`.

## Architecture overview

```
                ┌────────────────────────────────────────────────────┐
                │                  runner                            │
                │  • fork(backend), fork(web)                        │
                │  • restart FSM, update FSM, maintenance flag       │
                │  • /health probe every 5s per child                │
                │  • fork IPC for control (drain/stop/set-flag)      │
                └────────────────────────────────────────────────────┘
                                │ fork + IPC                  │
                ┌───────────────┘                             └──────────────┐
                ▼                                                            ▼
   ┌──────────────────────────────────┐                ┌─────────────────────────────────┐
   │           backend                │                │             web                 │
   │  • SQLite (WAL)                  │                │  • Express/Fastify static       │
   │  • engine, poller, workers       │                │  • reverse-proxy /api → backend │
   │  • config hot-reload (chokidar)  │◀────HTTP──────│  • serves built SPA             │
   │  • public HTTP api               │  loopback     │  • crash harmless               │
   │  • MCP HTTP transport            │                └─────────────────────────────────┘
   │  • SSE event stream              │                                ▲
   └──────────────────────────────────┘                                │
                ▲              ▲                                       │
                │HTTP+SSE      │HTTP/MCP                            HTTP
                │              │                                       │
        ┌───────┴───────┐  ┌───┴───────┐                       ┌──────┴──────┐
        │     tui       │  │MCP client │                       │   browser   │
        │ (HTTP client) │  │           │                       │             │
        └───────────────┘  └───────────┘                       └─────────────┘
```

## Data flow

**Read flow (tui or web requests run list)**:
1. Client sends `GET /api/runs` with bearer token.
2. (Web only) web reverse-proxies to backend.
3. Backend middleware: auth → zod validate query → route handler.
4. Route handler queries SQLite, returns `ApiResponse<Run[]>` (shape from `@night-orch/shared`).
5. Client renders.

**Event flow (engine emits run phase complete)**:
1. Engine code calls `events.emit('run.phase_complete', payload)`.
2. In-process EventEmitter (no broker) fans out to:
   - SSE subscribers (`/api/events` HTTP clients).
   - Metrics exporter.
   - Checkpoint writer.
3. SSE handler serializes as `SseEvent<RunPhaseCompleteEvent>` and writes to each connected client.
4. tui / web receive event, update local state.

**Control flow (runner sets maintenance)**:
1. Runner receives external trigger (e.g. update CLI command).
2. Runner sends `{ type: 'set-maintenance', value: true }` over fork IPC to backend.
3. Backend stores flag in memory, includes in next `/health` response, emits `MaintenanceEvent` on SSE.
4. tui / web banner switches; write endpoints respond `503 maintenance`.

## Error handling

- **HTTP errors**: backend returns `ApiError` envelope (`{ code, message, details }`) with HTTP status. Web SPA + tui both render structured errors.
- **Backend crash mid-request**: clients receive connection reset / 502. Idempotent ops safe to retry. Non-idempotent ops (e.g. `POST /api/runs/:id/retry`) must include client-supplied request ID for dedup at backend.
- **SSE disconnect**: clients reconnect with `Last-Event-ID`; backend replays missed events from a bounded in-memory ring buffer (size = 1000 events; older ones forfeit, client may need to refetch state).
- **Worker subprocess SIGTERM during backend crash**: engine reads checkpoint on restart, restarts the run from last completed phase. Existing behavior, unchanged.
- **Runner config invalid on reload**: runner keeps previous topology, logs error, emits health alert. Never spawns with bad config.

## Migration plan (high-level — detailed plan comes in writing-plans)

Each step independently shippable:

1. **Workspace skeleton**: add pnpm workspace, create `packages/shared/` (empty stub). Move pure-fn modules (decide, parsers, label mutation, prompt compile) + existing domain types + zod config schemas into `shared`. Add the purity ESLint rule (D5). Re-export from old paths via barrel files for source-compatibility. No behavior change.
2. **Extract `packages/backend`**: move `src/loop/`, `src/state/`, `src/forge/`, `src/workers/`, `src/poller/`, `src/runner/`, `src/discovery/`, `src/mentions/`, `src/reactions/`, `src/publishing/`, `src/labels/`, `src/notify/`, `src/metrics/`, `src/ops/`, `src/git/`, `src/environment/`, `src/mcp/`, `src/web/` (routes, auth, server) into `packages/backend/src/`. Update imports. Still single process.
3. **Extract `packages/runner`**: move `src/supervisor/` to `packages/runner/`. No new behavior yet — same children as today (run + web).
4. **Extract `packages/web`**: move `web/` workspace into `packages/web/`. SPA build unchanged.
5. **Split process boundaries**:
   - 5a. Web becomes a reverse-proxy + static server (instead of an in-process route handler). It binds its own public port (the port browsers connect to today) and proxies `/api/*` + `/api/events` to backend's loopback port. Backend binds a separate loopback-only port for api + MCP.
   - 5b. Runner forks backend + web as separate processes (replaces today's `run` + `web` fork pattern with a cleaner shape). Web's proxy target URL is supplied by runner via fork-IPC config message at child startup.
6. **Formalize `@night-orch/shared` as the contract source**: migrate routes + handlers + SSE serializers to consume schemas from `shared`. Delete any duplicate type defs in backend/web/runner/cli.
7. **Tui extraction prep**: extract `src/cli/tui/` to a tidy folder inside `packages/cli/src/tui/` (still inside cli pkg). Rewire to call backend HTTP api instead of in-process imports.
8. **Health endpoint formalization**: every child exposes `/health` per D8. Runner uses `/health` plus fork-IPC heartbeats.

Maintenance flag, staged update FSM, and config hot-reload land in subsequent specs that build on this foundation.

## Testing strategy

**Per package:**
- `shared`: schema validation tests (zod parses, rejects bad input) + existing exhaustive unit tests on `decide`, `computeLabelMutation`, parsers, prompt compile.
- `backend`: integration tests with `:memory:` SQLite + fake forge adapter + fake worker. Hit HTTP routes, assert DB state and SSE events.
- `web`: reverse-proxy smoke test (proxy forwards auth header + body verbatim, preserves SSE framing).
- `runner`: spawn fake child scripts that implement `/health` and fork-IPC, assert restart on crash, backoff timing, update FSM transitions, maintenance flag propagation.

**Cross-process E2E:**
- Harness spins up runner + backend + web with temp `dataDir`, fake forge, real SQLite tempfile.
- Curl-style assertions on api endpoints, kill backend mid-run, assert resume from checkpoint.
- Kill web, assert tui still works.

**Contract tests:**
- All `ApiRequest`/`ApiResponse`/`SseEvent` schemas in `@night-orch/shared` get round-trip tests.
- Web reverse-proxy + backend api: assert envelope shapes match on both sides.

## Open follow-up specs

- **Staged update FSM**: state diagram, drain semantics, timeout matrix, rollback flow, version-mismatch detection between runner and backend.
- **Config hot-reload**: apply matrix (which fields are live-applicable vs. require child restart), watcher debounce, validation-before-apply, project config discovery.
- **Auth model**: token rotation, scoped tokens, multi-user, SSO hooks.
- **SSE backpressure**: ring buffer sizing, slow-client eviction, `Last-Event-ID` replay limits.
- **Publish strategy**: which packages go public on npm, semver coupling between them.

## Risks

- **Reverse-proxy latency in web**: adds one hop. Mitigation: same-host loopback (sub-ms), HTTP/1.1 keep-alive between web and backend.
- **Fork IPC reliability**: structured messages over `process.send` are well-trodden but can be missed if backend is mid-GC. Mitigation: every fork IPC command is idempotent and acknowledged via response message with timeout.
- **Type drift between packages**: `@night-orch/shared` mitigates, but only if everyone imports from there. Mitigation: lint rule forbidding cross-package imports that bypass `shared` for any cross-process payload type.
- **Bigger blast radius for backend**: backend now holds engine + api + MCP. A leak in MCP can OOM the engine. Accepted trade — alternative (separate api process) was rejected because the api layer was not the unstable layer in night-orch. Re-evaluate if production data shows otherwise.

## Success criteria

- Web process can be killed and respawned without interrupting any active run.
- Backend can be killed mid-run; on restart, the engine resumes the run from the last checkpoint, with the same outcome as if the crash had not occurred.
- TUI can be launched from a separate shell session and shows live state via SSE within 1 second of an event.
- `@night-orch/shared` is the single source of truth for all cross-process payload shapes; no duplicate type definitions exist in `backend`, `web`, `runner`, or `cli`.
- `runner` package is ≤ 800 LOC and depends only on `shared` (no engine/DB code).
- `shared` has zero internal package deps and the purity ESLint rule passes.
