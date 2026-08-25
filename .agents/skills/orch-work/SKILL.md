---
name: orch-work
description: Pick up any work source — a GitHub issue, a plan, a phase, or pasted intent — analyse it thoroughly, agree the implementation mode (how to co-work with Codex and sub-agents), state a Definition of Done, then drive the night-orch change to completion with review baked in, looping until the goal is met, the pnpm gate is green, and a fresh reviewer confirms zero findings. Use when the user says "work this", "/orch-work", "execute this", "implement this", "build this to done", or "grind until green" on night-orch itself.
---

# Work a night-orch Change to Done

Take any work source and drive a night-orch change to a verified finish. This is the interactive
counterpart to the `loop-engine` (which is the orchestrator's batch executor); use this when you
are building night-orch itself and want to grind a feature or phase to done with review baked in.

## 1. Ingest the source — analyse everything first

Accept **any** of: a GitHub issue (`gh issue view <N> ...`), a plan file (`tmp/plans/*.md` or a
plan from `/orch-plan`), a spec/phase, or pasted intent. Read it in full; follow references. Then
dispatch `Explore` subagents to map what the change touches across `src/` (forge/worker adapters,
loop engine, the web surface) and the tests that cover it. Print a **one-paragraph hypothesis
read** of what is being asked — your starting understanding, not the work.

## 2. Goal / Definition of Done

State a one-line **Definition of Done** in observable terms. Name the completion gate:

```bash
pnpm test && pnpm typecheck && pnpm lint   # vitest + tsc + eslint — the night-orch gate
```

Bind a tracking issue if one exists — but do not require one.

## 3. Implementation-mode interview — pick once, ask `AskUserQuestion`

Agree how we co-work before building. Session-scoped, never persisted. **Always ask — never skip
this and never silently assume a default.** Ask across three axes:

**Builder mode**
- **Mode 1 — Claude builds, Codex reviews (recommended pick).** Loop: build → Codex review →
  address → re-review → until no findings.
- **Mode 2 — Codex builds the code.** Claude commissions Codex via the Codex MCP (a short spec),
  **waits**, then reviews. Loop to clean, then a final fresh Codex confirms. Docs/plans always Mode-1-style.

**Parallelism** — serial single-writer (recommended for coupled work) vs fan-out independent
slices to parallel subagents, one writer per file/pass.

**Autonomy / check-in cadence** — how hands-off, and when to surface.

### Codex-call rules (both modes)
Shortest possible prompt (Codex loads `AGENTS.md`); review calls return a terse verdict + one line
per finding (`file:line`), run inside a subagent that returns only the distilled verdict; never
override model/reasoning-effort; one writer per pass.

## 4. Loop to completion

Build + review until **the Definition of Done is met AND a fresh independent reviewer confirms
zero findings**. Use TDD where it fits. Run the review via `/orch-review` (the 8-point checklist +
mandatory Codex second opinion); for a harsh maintainability pass, invoke
`thermo-nuclear-code-quality-review`.

**Guards (always):** never treat a missing/errored review as clean; stop and ask on oscillation or
~3 rounds of no net progress; run the pnpm gate and observe it green before claiming done.

## 5. Endgame / handoff

On terminal clean: sync the tracking issue if bound, hand off to commit-message suggestion, and
suggest `/orch-pr`. **Never auto-commit and never push.**

## Rules

- Mode and parallelism are session-scoped; never persisted.
- **Always run the §3 mode interview** — never skip it or assume a default.
- One writer per pass — two agents never edit the working tree simultaneously.
- Not done until the Definition of Done is met, a fresh reviewer confirms zero findings, and the pnpm gate ran green.
- Never auto-commit; suggest the commit message and the PR.

## Cross-references

- `/orch-plan` — produces the plan this skill executes.
- `/orch-review` — the 8-point + Codex review used in the loop.
- [thermo-nuclear-code-quality-review](../thermo-nuclear-code-quality-review/SKILL.md) — the harsh maintainability audit.
- `/orch-pr` — the Endgame PR step.
