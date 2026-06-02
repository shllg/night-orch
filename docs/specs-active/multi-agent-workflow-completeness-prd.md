# PRD: Multi-Agent Workflow Completeness

**Status:** Draft — 2026-06-02
**Owners:** TBD per phase
**Related:** [agent-observability-prd.md](agent-observability-prd.md), [remaining-work.md](remaining-work.md)

## Problem

Night-orch can already model the canonical multi-stage flow plan → code → verify → review → decide with per-role agent overrides, custom prompts, and label routing. Real workflows the operator wants to run end-to-end expose five gaps:

1. **G1 — Single reviewer slot.** A workflow with two reviewer steps (e.g. `review` + `cr`) overwrites `RunContext.reviewResult`. Findings from the earlier step are lost on the next iteration.
2. **G2 — No first-class external review tool integration.** Running CodeRabbit (CLI or skill-driven), Snyk, custom linters, etc. against an open PR and folding their output back into the loop must be done by hand.
3. **G3 — Inter-agent handoffs are opaque.** Plan → Code → Review payloads live only inside the live `RunContext` and `runs.phase_data` JSON. After a restart the operator cannot tell what one agent said to the next. Corrupted `phase_data` is quarantined silently.
4. **G4 — Free-form `@night-orch` mentions are ignored.** Only the explicit `/orch <cmd>` syntax routes back into the loop. Comments like `@night-orch please rework error handling` are dropped. CodeRabbit (`coderabbitai[bot]`) review comments are filtered as bot noise.
5. **G5 — Worker execution context is undocumented.** CWD already resolves to the worktree (see `src/workers/sandcastle.ts:102`, `src/workers/acp.ts:55,71`), so repo-local `.claude/skills/` and `.claude/commands/` are reachable — but this contract is not stated anywhere user-facing, so authors are unsure whether they may rely on it.

## Goals

- Two or more reviewer steps in one workflow produce a merged finding set that the coder sees on the next iterate.
- An external review tool (CodeRabbit-style) can be plugged in via a single workflow step and a single config flag, with its output flowing through the existing reaction → continue pipeline and a `[night-orch]` prefixed comment on the issue/PR.
- Every agent-to-agent handoff (plan, code summary, each reviewer's findings, verify summary, external review output) is persisted as a first-class row, inspectable retrospectively and used for restart recovery independently of `phase_data`.
- `@night-orch` (and configured aliases) mentions anywhere on the issue or PR trigger the same code path as `/orch continue` with the mention body as feedback. Configured review bots (CodeRabbit, Copilot) are allowlisted into the same feedback channel.
- The repo-local skill execution contract is documented and tested.

## Non-Goals

- New worker adapter types.
- Cross-run learning / prompt self-tuning (tracked separately as the self-improvement gap).
- Visual swimlane UI redesign — text/timeline views only this round.
- Forgejo merge-queue parity (out of scope).

## Phases

Five phases. Each is independently shippable; ordering reflects dependency, not strictness. Each phase has its own acceptance criteria and matches project rule `.claude/rules/05-specs.md`.

| Phase | Topic | Depends on | Approx LOC |
|-------|-------|------------|------------|
| 1 | G5 — Worker CWD docs | none | docs only |
| 2 | G3 — Handoff persistence | none | ~400 + tests |
| 3 | G1 — Multi-reviewer aggregation | Phase 2 (visibility) | ~250 + tests |
| 4 | G2 — External review step + reaction | Phases 2, 3 | ~500 + tests |
| 5 | G4 — Mention mining + bot allowlist | Phase 4 (bot allowlist shape) | ~300 + tests |

---

## Phase 1 — G5: Worker Execution Context Documentation

### Summary

Document the verified contract that worker processes are spawned with `cwd = worktreePath`, that the worktree is a full git checkout including repo-local `.claude/skills/`, `.claude/commands/`, and `.night-orch/prompts/`, and that prompts can rely on this for invoking repo-scoped skills.

### Files to Modify

- `docs/CONFIGURATION.md` — add **Worker execution context** subsection under "Workers".
- `docs/OVERVIEW.md` — add one-line mention in the Workers section that prompts execute inside the worktree.
- `docs/USAGE.md` — add note under "Prompts" subsection explaining the skill access.
- `examples/config.example.yaml` — add commented example showing repo-local prompt referencing a skill.

### Files to Create

- `test/workers/cwd-contract.test.ts` — asserts adapters pass `cwd: input.worktreePath`. Mocks `sandcastleRun` and the ACP transport.

### Acceptance Criteria

- Doc explicitly states: worker CWD = worktree, full clone, `.claude/` visible, skills callable from prompt body.
- Doc states the explicit security note: env still goes through `buildWorkerEnv()` whitelist; CWD access does not relax env isolation.
- `cwd-contract.test.ts` passes with current code (no production change).
- `pnpm docs:build` succeeds.

### Out of Scope for Phase 1

- Worker CWD becoming configurable.
- Changes to the worktree provisioning logic.

---

## Phase 2 — G3: Persisted Agent Handoffs

### Summary

Introduce an `agent_handoffs` table that records, for every workflow step that produces a structured output, what was passed from one agent (or system phase) to the next. Used for retrospective inspection and restart recovery independent of `runs.phase_data`.

### Data Model

Migration `032-agent-handoffs.ts`:

```sql
CREATE TABLE agent_handoffs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_id    TEXT    NOT NULL,           -- denormalised for chain-aware queries
  step_id       TEXT    NOT NULL,           -- 'plan' | 'code' | 'review' | 'cr' | 'verify' | external step id
  from_role     TEXT,                       -- 'planner' | 'coder' | 'reviewer' | 'system' | null
  to_role       TEXT,                       -- next role in the workflow, or null on terminal
  kind          TEXT    NOT NULL,           -- 'plan' | 'code-summary' | 'review-findings' | 'verify-summary' | 'external-review-findings'
  summary       TEXT    NOT NULL,           -- 1–2 line operator-readable digest
  content_md    TEXT    NOT NULL,           -- rendered markdown of the artefact
  content_json  TEXT,                       -- structured parsed worker output (zod-validated)
  token_usage   TEXT,                       -- JSON: { prompt, completion, cacheRead }
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_handoffs_run        ON agent_handoffs(run_id, id);
CREATE INDEX idx_handoffs_attempt    ON agent_handoffs(attempt_id, id);
CREATE INDEX idx_handoffs_kind       ON agent_handoffs(run_id, kind);
```

### Interfaces

```typescript
// src/state/handoffs.ts

export type HandoffKind =
  | 'plan'
  | 'code-summary'
  | 'review-findings'
  | 'verify-summary'
  | 'external-review-findings';

export interface AgentHandoff {
  readonly id: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly stepId: string;
  readonly fromRole: string | null;
  readonly toRole: string | null;
  readonly kind: HandoffKind;
  readonly summary: string;
  readonly contentMd: string;
  readonly contentJson: unknown | null;
  readonly tokenUsage: TokenUsage | null;
  readonly createdAt: Date;
}

export interface RecordHandoffInput {
  runId: string;
  attemptId: string;
  stepId: string;
  fromRole: string | null;
  toRole: string | null;
  kind: HandoffKind;
  summary: string;
  contentMd: string;
  contentJson?: unknown;
  tokenUsage?: TokenUsage;
}

export function recordHandoff(db: Database, input: RecordHandoffInput): AgentHandoff;
export function listHandoffs(db: Database, runId: string): AgentHandoff[];
export function getLatestHandoffByKind(db: Database, runId: string, kind: HandoffKind): AgentHandoff | null;
```

### Files to Create

- `src/state/migrations/032-agent-handoffs.ts`
- `src/state/handoffs.ts` — repository helpers (parameterised queries only).
- `src/loop/handoff-render.ts` — pure functions: `renderPlanHandoff(plan): { summary, contentMd, contentJson }`, similar for code/review/verify/external.
- `src/mcp/tools/handoffs.ts` — `night-orch-handoffs` tool.
- `src/cli/commands/handoffs.ts` — CLI parity command (`night-orch handoffs <runId>`).
- `src/cli/tui/handoffs-panel.tsx` — TUI panel reusable inside the run detail view.
- `test/state/handoffs.test.ts`
- `test/loop/handoff-render.test.ts`
- `test/mcp/handoffs-tool.test.ts`
- `test/loop/restart-recovery.test.ts` — restart path reads handoffs.

### Files to Modify

- `src/loop/step-executor.ts` — after each successful worker/verify step, call `recordHandoff(...)` inside the same transaction as the checkpoint write.
- `src/loop/checkpoint.ts` — restart fallback: when `phase_data` is quarantined, attempt to reconstruct `RunContext.plan / codeResult / reviewResults / verifyResults` from the latest handoff per kind. Emit `recovery_from_handoff` event when used.
- `src/loop/types.ts` — no signature change; document that `plan` / `reviewResults` can be repopulated from handoffs.
- `src/mcp/tools/index.ts` — register `night-orch-handoffs`.
- `src/cli/commands/index.ts` — register CLI command.
- `src/cli/tui/runs-view.tsx` — add `Handoffs` tab. Wire to `handoffs-panel.tsx`.
- `docs/CONFIGURATION.md`, `docs/OVERVIEW.md`, `docs/USAGE.md` — describe the new surface.

### Acceptance Criteria

- After a successful plan step, exactly one row with `kind='plan'`, `from_role='planner'`, `to_role='coder'`, `content_md` containing the rendered plan, and `content_json` parseable as `PlannerOutputContractSchema`.
- After a review step, exactly one row with `kind='review-findings'`, `from_role='reviewer'`, `to_role='coder' | 'system'` (`'system'` when `decide → publish`), summary = verdict + finding count.
- Verify step emits `kind='verify-summary'` with `content_md` listing each command and pass/fail.
- `night-orch-handoffs --run-id X` MCP tool returns rows ordered by `id ASC` with summary + markdown.
- CLI `night-orch handoffs <runId>` shows the same ordered list with collapsed markdown previews.
- TUI Handoffs tab opens from the run detail screen, j/k navigation, Enter expands markdown.
- Restart recovery: when `phase_data` is corrupted (forced in a test by NULLing it), the engine reconstructs `ctx.plan` and `ctx.reviewResults` from the handoffs and resumes the workflow. Emits `recovery_from_handoff` event in `run_log_events`.
- No SQL string interpolation. All inserts/queries parameterised. Transactional.
- `pnpm typecheck && pnpm lint && pnpm test` green.

### Restart Recovery Contract

1. Engine loads checkpoint normally.
2. If `phase_data` row is in `checkpoint_quarantine` **or** if a structured field (e.g. `ctx.plan` after the plan step) is missing, the engine reads the latest handoff per kind for the run and rehydrates the `RunContext`.
3. If neither path produces a usable context, run is marked `blocked` with `BlockReason.checkpointUnrecoverable`.

### Out of Scope for Phase 2

- Disk artefacts (`.night-orch/handoffs/<runId>/*.md`). Decision: DB-only.
- Cross-run handoff comparison / diff UI.
- Public-facing web tab (TUI + MCP + CLI only this phase).

---

## Phase 3 — G1: Multi-Reviewer Aggregation

### Summary

Replace the single-reviewer slot in `RunContext` with a map keyed by `stepId`. `decide()` reads the merged finding set and applies a worst-of verdict. Existing single-reviewer workflows behave identically.

### Interfaces

```typescript
// src/loop/types.ts

interface RunContext {
  // REMOVED: readonly reviewResult: ReviewerOutput | null
  readonly reviewResults: Readonly<Record<string, ReviewerOutput>>;     // keyed by step.id
  readonly reviewFindings: ReadonlyArray<ReviewFinding & {
    readonly sourceStepId: string;
    readonly sourceRole: string;
  }>;
  // ...other fields unchanged
}

// src/loop/decision.ts

type AggregateVerdict = 'BLOCKED' | 'CHANGES_REQUIRED' | 'APPROVED';
function aggregateReviewVerdict(results: Readonly<Record<string, ReviewerOutput>>): AggregateVerdict;
```

### Decision Rules (additions)

Priority order in `decide()` (unchanged top-level priorities):

1. Cost / pass / iteration caps — unchanged.
2. `aggregateReviewVerdict(ctx.reviewResults)` replaces single-reviewer verdict lookup:
   - Any `BLOCKED` → `BLOCKED`.
   - Else any `CHANGES_REQUIRED` → `CHANGES_REQUIRED`.
   - Else if all `APPROVED` → `APPROVED`.
   - Empty map (no review step ran) → existing "review parse failure" path.
3. On `iterate`, `ctx.reviewFindings` (union, deduped by `(sourceStepId, code, location)`) is fed to coder.

### Step Configuration

`WorkflowWorkerStepSchema` gains optional `reviewerKey?: string`. Defaults to `step.id`. Useful when two reviewer steps want to write to the same slot (e.g. retried reviewer) — explicit, not magic.

### Files to Modify

- `src/loop/types.ts` — context shape.
- `src/loop/decision.ts` — aggregation + verdict logic.
- `src/loop/engine.ts` — when a worker step with `role='reviewer'` completes, write into `reviewResults[reviewerKey]`, append findings with `sourceStepId`/`sourceRole`.
- `src/loop/step-executor.ts` — accept new field.
- `src/loop/review-feedback.ts` — render findings grouped by `sourceStepId`.
- `src/config/schema.ts` — add `reviewerKey` to worker step schema.
- `src/state/run-state-store.ts` (or wherever `phase_data` is serialised) — encode `reviewResults` as map.
- `examples/config.example.yaml` — two-reviewer workflow example.
- `docs/CONFIGURATION.md` + `docs/USAGE.md`.

### Files to Create

- `test/loop/decision-multi-reviewer.test.ts` — table-driven over verdict combinations.
- `test/loop/engine-multi-reviewer.test.ts` — integration: workflow with `review` + `cr` step, both produce findings, coder receives union.
- `test/config/multi-reviewer-schema.test.ts`.

### Acceptance Criteria

- Two reviewer steps in one workflow both contribute findings to the next coder iterate.
- Worst-of verdict: `BLOCKED` from any reviewer dominates.
- Single-reviewer workflows still pass all existing tests with no config change.
- Backwards-compatible deserialisation of pre-existing `runs.phase_data` (the migration treats legacy `reviewResult` as a single entry under key `review`).
- `phase_data` serialisation roundtrips through restart.
- `pnpm typecheck && pnpm lint && pnpm test` green.

### Out of Scope for Phase 3

- Reviewer-level cost caps.
- Reviewer-level model selection beyond what worker profiles already allow.

---

## Phase 4 — G2: External Review Step + `external_review` Reaction

### Summary

A workflow step authored as `type: worker, role: reviewer` gains `runWhen: 'pre-decide' | 'post-publish'`. `post-publish` runs after PR creation, treats the parsed output as a new reaction kind `external_review`, and routes back through `continue` op exactly like `review_comment`. The step is the integration surface for CodeRabbit-style tooling — whether the worker invokes a local CLI, an MCP tool, or a Claude skill is the prompt author's choice.

### Step Configuration

```yaml
workflows:
  full-with-cr:
    steps:
      - { type: worker, id: plan, role: planner, skipWhen: trivial }
      - { type: worker, id: code, role: coder,  continueFrom: plan }
      - { type: verify, id: verify }
      - { type: worker, id: review, role: reviewer }
      - { type: decide, id: decide, onIterate: code }

      # Post-publish CodeRabbit pass — runs after PR is open
      - type: worker
        id: cr
        role: reviewer
        runWhen: post-publish
        prompt: .night-orch/prompts/cr-skill.md       # may invoke $cr-code-review or CLI
        onChangesRequired: continue                    # 'continue' | 'comment-only'
        commentOnIssue: true                           # default true
        commentPrefix: "[night-orch][cr]"              # appended to standard prefix
```

Schema additions on `WorkflowWorkerStepSchema`:

```typescript
runWhen: z.enum(['pre-decide', 'post-publish']).default('pre-decide')
onChangesRequired: z.enum(['continue', 'comment-only']).default('continue')
commentOnIssue: z.boolean().default(true)
commentPrefix: z.string().optional()                   // sugar; default '[night-orch]'
```

### Engine Flow

1. Standard loop runs `pre-decide` steps and may publish (`decide → publish`).
2. After publish, engine enumerates `post-publish` worker steps in workflow order.
3. For each, dispatch the same worker step path (full prompt compile, `cwd = worktreePath`, env whitelist, parser).
4. Result parsed as `ReviewerOutputContractSchema` → `ctx.reviewResults[stepId]` updated → handoff row with `kind='external-review-findings'`.
5. If verdict ≠ APPROVED:
   - `onChangesRequired='continue'`: enqueue a `continue` op with `reaction: external_review`, payload = findings rendered as feedback text, sanitised via `sanitizeReviewFeedback()`.
   - `onChangesRequired='comment-only'`: skip continue, only post comment.
6. If `commentOnIssue=true`, upsert a comment on the issue conversation (not the PR) via `upsertBotComment()` with marker `<!-- night-orch:${stepId}-${attemptId} -->` and body prefixed with `commentPrefix ?? '[night-orch]'`.

### Reaction Type

```typescript
// src/reactions/types.ts
type ReactionType =
  | 'ci_failure'
  | 'human_review'
  | 'review_comment'
  | 'merge_conflict'
  | 'external_review';    // NEW
```

`continue` op (`src/ops/continue.ts`) gains a branch for `external_review`: builds coder feedback text from the rendered findings markdown produced by `handoff-render.ts`.

### Files to Modify

- `src/config/schema.ts` — workflow step fields.
- `src/loop/workflow.ts` — order resolution, expose `getPostPublishSteps(workflow)`.
- `src/loop/engine.ts` — post-publish execution loop after `publish`.
- `src/loop/step-executor.ts` — accept new flags.
- `src/reactions/types.ts` — add `external_review`.
- `src/reactions/scanner.ts` — accept synthetic `external_review` reactions from the engine itself (not derived from forge polling).
- `src/ops/continue.ts` — render external review findings as feedback.
- `src/forge/bot-comment.ts` — accept custom prefix.
- `docs/CONFIGURATION.md`, `docs/USAGE.md`, `examples/config.example.yaml`.

### Files to Create

- `src/loop/post-publish.ts` — orchestrator for post-publish steps.
- `test/loop/post-publish.test.ts` — integration covering happy path, `comment-only`, multiple post-publish steps in order.
- `test/ops/continue-external-review.test.ts`.
- `test/forge/bot-comment-prefix.test.ts`.
- `.night-orch/prompts/cr-skill.md` (template only, under `examples/`).

### Acceptance Criteria

- Workflow with one `post-publish` reviewer step runs after PR creation, posts a `[night-orch][cr]` prefixed comment to the issue with findings rendered as markdown.
- When the parsed output is `CHANGES_REQUIRED`, a `continue` op is enqueued with the findings as feedback; coder receives the union of `pre-decide` reviewer findings (Phase 3) and this external review's findings.
- `onChangesRequired='comment-only'` posts the comment but does not enqueue a continue.
- A second post-publish step (e.g. Snyk) runs in declared order. Handoff rows recorded for each.
- Comment is upserted (no duplicates) across retries using the per-attempt marker.
- Skipping when no PR has been created yet (e.g. block before publish) is a no-op.
- `pnpm typecheck && pnpm lint && pnpm test` green.
- Doc sections updated per `.claude/rules/07-config-doc-sync.md`.

### Security Notes

- The external worker step runs through the existing `buildWorkerEnv()` whitelist — tokens still excluded.
- Worker output is treated as untrusted: parser must reject unknown verdicts; feedback sanitised before injection.
- Comment bodies sanitised the same way human review comments are.

### Out of Scope for Phase 4

- Long-running async tools that produce results after the engine moves on (would need webhook-driven reactions).
- Scheduling post-publish steps on a delay.

---

## Phase 5 — G4: Mention Mining + Review-Bot Allowlist

### Summary

`@night-orch` (and configured aliases) in any non-bot comment on the issue or PR triggers the same code path as `/orch continue` with the comment body as feedback. Comments authored by allowlisted review bots (CodeRabbit, Copilot) are accepted as `review_comment` reactions instead of being dropped as bot noise.

### Configuration

```yaml
commentCommands:
  requireCollaborator: true
  acceptMentions: true                           # default true
  mentionAliases: ["@night-orch", "@orch"]       # in addition to configured bot username
  reviewBotAllowlist:
    - "coderabbitai[bot]"
    - "copilot[bot]"
```

### Mechanism

- `src/runner/comment-commands.ts` exports `parseMentions(text, aliases)` returning `MentionMatch[]`.
- `src/runner/comment-commands.ts` extends comment collection to include review bot comments when the author matches `reviewBotAllowlist`.
- New reaction kind `mention_feedback` with payload `{ author, body, locationKind, commentUrl }`.
- `continue` op consumes `mention_feedback` and `review_comment` identically — body sanitised, rendered as `[Review by @author]: …`, fed to coder.
- Self-mentions (bot mentioning bot, or itself via marker re-quote) skipped via existing bot-comment marker detection.
- Acknowledgement comment uses marker `<!-- night-orch:mention-ack-${commentId} -->` so we never reply twice.

### Files to Modify

- `src/config/schema.ts`.
- `src/runner/comment-commands.ts` — `parseMentions`, allowlist collection.
- `src/reactions/types.ts` — add `mention_feedback`.
- `src/reactions/scanner.ts` — emit `mention_feedback` and bot-allowlist `review_comment`.
- `src/loop/review-feedback.ts` — relax bot filter when author is allowlisted.
- `src/ops/continue.ts` — accept `mention_feedback` payload.
- `docs/CONFIGURATION.md`, `docs/USAGE.md`.

### Files to Create

- `test/runner/parse-mentions.test.ts` — alias matching, code-fence stripping, self-skip.
- `test/reactions/mention-feedback.test.ts`.
- `test/loop/review-bot-allowlist.test.ts`.
- `test/ops/continue-mention.test.ts`.

### Acceptance Criteria

- `@night-orch please add tests for foo` on a PR review comment enqueues `continue` with that body as feedback.
- Code-fenced mentions are ignored (consistent with `/orch` command behaviour).
- A configured review bot (`coderabbitai[bot]`) posting a PR review comment routes into `review_comment` feedback instead of being silently dropped.
- A comment authored by the bot itself is never treated as a mention (no self-trigger loops).
- Reply acknowledgement comment is idempotent under retry (marker-based dedup).
- `requireCollaborator: true` still gates mention authors that are humans; bot allowlist is checked before the collaborator gate for bot authors.
- `pnpm typecheck && pnpm lint && pnpm test` green.

### Out of Scope for Phase 5

- Webhook-based comment ingestion (still poll-based via reaction scanner).
- Natural-language command parsing inside mentions (`@night-orch retry plan` → still requires explicit `/orch retry --reset-plan`).

---

## Cross-Cutting Concerns

### Security checklist (apply to every phase)

- New env vars: none introduced. `buildWorkerEnv()` whitelist unchanged.
- New external content into prompts: external review output and mention bodies must pass `sanitizeReviewFeedback` (or new equivalent for plain comment bodies).
- DB queries parameterised. No string interpolation.
- Bot-comment marker-based dedup on every new comment surface.
- Logging excludes full forge response bodies; logs only status codes + reaction kind.

### Documentation sync (per `.claude/rules/07-config-doc-sync.md`)

Every phase that changes config schema, CLI/MCP surface, or runtime behaviour must update `docs/CONFIGURATION.md` + `docs/USAGE.md` + relevant section of `docs/OVERVIEW.md` in the same PR, with sidebar/nav additions in `docs/.vitepress/config.ts` if new top-level pages appear.

### Testing strategy

- `decide()` and `aggregateReviewVerdict()` are pure — exhaustive table-driven tests.
- DB-layer tests use `:memory:` SQLite.
- Forge/worker calls mocked.
- Forge contract tests (`test/forge/contract.test.ts`) untouched unless a new forge call is introduced.
- Restart recovery test forces `phase_data` to NULL and asserts handoff-based rehydration.

### Metrics additions (`src/metrics/collectors.ts`)

- Phase 2: `night_orch_handoffs_total{kind}` counter; `night_orch_recovery_from_handoff_total` counter.
- Phase 4: `night_orch_post_publish_steps_total{step_id,result}`; `night_orch_external_review_findings_total{step_id,verdict}`.
- Phase 5: `night_orch_mention_feedback_total{location}`; `night_orch_review_bot_comments_total{author}`.

### Migration ordering

Existing latest migration: `031` (rebase fan-out siblings). This PRD adds `032-agent-handoffs.ts` only. No other schema changes required across the five phases.

---

## Open Questions

- Should `night-orch-handoffs` MCP tool support pagination, or is "last N" enough? (Default: full list, cap at 200; same shape as `run-detail`.)
- Should post-publish steps run inside the same lease as the original attempt, or take a fresh short-lived lease? (Default: same lease, extend heartbeat.)
- Should review-bot allowlist support glob (`*[bot]`) or only exact match? (Default: exact only; explicit is safer.)
