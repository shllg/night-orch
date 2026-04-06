# Night-Orch — Remaining Work

All phases are implemented. This document tracks *genuinely open* gaps
verified against the current codebase as of 2026-04-06. Items that were
previously listed here but have since been implemented are removed.

---

## Merge Queue — Forgejo Feature Parity

The merge queue depends on `getPRCheckStatus`, `getRefCheckStatus`, and
`updateRef` which are only implemented in the GitHub adapter. Forgejo repos
with `mergeQueue.enabled: true` are now rejected at config-load time (schema
`superRefine`). To lift that restriction, implement the three methods
against Forgejo's `/repos/{o}/{r}/commits/{sha}/status` and ref update
endpoints, and add parameterized contract tests.

---

## Grafana Dashboard

`grafana/dashboard.json` — pre-built import-ready dashboard covering all
Prometheus metrics. The metrics themselves are wired; the dashboard JSON
has not been authored.

---

## Metrics Integration — Spot-Check

Most metrics call-sites are wired. A formal sweep against the Phase 9 spec
list is needed to confirm every counter/histogram is covered and no
hot-path metric call blocks on error.

---

## Config Fields: doneMode / notifyPriority

`repos[].defaults.doneMode` and `repos[].defaults.notifyPriority` are
defined in the schema and shown in the web UI but are never consumed by the
loop engine or notification dispatch. Either wire them into runtime
behavior or remove in a future breaking-config release.

---

## Worker Profile: minimalEnv

`workerProfiles[].minimalEnv` is parsed by the schema but ignored at
runtime — all workers use whitelist-only env mode unconditionally. Marked
`@deprecated` in the schema; remove from the schema and example config in
a future breaking-config release.
