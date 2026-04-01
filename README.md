# night-orch

A self-hosted Node.js/TypeScript CLI that autonomously processes GitHub/Forgejo issues using AI agents (Claude Code, Codex CLI). Runs overnight or unattended — discovers issues, plans, codes, reviews, and opens PRs.

## Features

- **Configurable workflows** — YAML-defined pipelines (Plan→Code→Verify→Review or custom)
- **Planning-only mode** — label an issue to produce a single PRD markdown artifact (no code changes)
- **Multi-agent support** — Claude, Codex, Gemini, and 17+ agents via ACP protocol
- **Issue decomposition** — automatically splits complex issues into parallel sub-tasks
- **Merge queue** — Bors-style batch-and-bisect for automated PR merging
- **Session persistence** — agents retain context across pipeline phases
- **Reaction engine** — auto-responds to CI failures and human review comments
- **Live monitoring** — terminal dashboard with active runs, costs, merge queue status
- **Prometheus metrics** — full observability with 13+ metrics
- **MCP integration** — 9 tools for Claude Code integration
- **GitHub + Forgejo** — dual forge support

## Quick Start

1. Install: `pnpm install`
2. Setup: `night-orch init` (guided wizard)
3. Verify: `night-orch doctor`
4. Labels: `night-orch labels-init`
5. Run: `night-orch run`
6. Monitor: `night-orch tui` (in another terminal)

## Setup

```bash
pnpm install
cp examples/config.example.yaml ~/.config/night-orch/config.yaml
# Edit config with your repos, tokens, and agent preferences
night-orch doctor    # validate setup
```

Requires Node.js 24+ and at least one agent CLI (`claude` or `codex`).

## Commands

```
night-orch run              # long-running poller daemon
night-orch run-once         # single poll cycle (for testing/CI)
night-orch init             # interactive setup wizard
night-orch doctor           # validate config, auth, CLIs, repos, DB
night-orch status           # show active runs, costs, recent history
night-orch tui              # live monitoring TUI dashboard
night-orch sync             # reconcile DB state with GitHub
night-orch retry <repo> <#> # re-run a blocked/errored issue
night-orch rebase <repo> <#> # rebase PR branch + verify, requeue if broken
night-orch cleanup          # remove stale worktrees, branches, logs
night-orch labels-init      # create/update GitHub labels from config
night-orch notify-test      # send test notification to all channels
night-orch mcp              # start MCP stdio server
```

All mutating commands support `--dry-run`.

To initialize labels from config defaults/overrides:

```bash
mise run labels-init -- myorg/myrepo
# or all configured repos
mise run labels-init
```

## How It Works

1. Poll configured repos for issues with `orch:ready` label
2. Claim issue (lease in SQLite, add `orch:running` label)
3. Create/reuse git worktree with deterministic branch name
4. **Plan** → **Code** → **Verify** → **Review** loop (the "Ralph loop")
5. Reviewer can bounce back to coder (up to configured max iterations)
6. Push branch, create/update PR, label `orch:review-ready`
7. Notify via console, webhook, GitHub comment, or email

Special case: issues labeled `orch:planning` (configurable) run in planning-only mode and generate only one PRD markdown file in the configured PRD directory.

The orchestrator's job ends when the PR is ready. A human merges.

## Development

```bash
pnpm dev doctor             # run via tsx
pnpm test                   # vitest
pnpm lint                   # eslint
pnpm typecheck              # tsc --noEmit
pnpm build                  # compile to dist/
```

## Commit Messages

Format: `[CATEGORY] Short imperative summary` (≤ 50 chars, no trailing punctuation)

| Category | Use for |
|------------|------------------------------------------|
| `[FIX]` | Bug fixes |
| `[FEATURE]` | New functionality |
| `[REFACTOR]` | Code restructuring without behavior change |
| `[INTERNAL]` | Tooling, config, dev-only changes |
| `[TEST]` | Test-only changes |
| `[DOCS]` | Documentation |

Body (optional): bullet points, imperative mood. Do not wrap lines.

## Architecture

See `docs/specs-active/index.md` for the full implementation spec with dependency graph and cross-cutting concerns.

## Key Design Decisions

- **GitHub issues are the queue** — no separate UI
- **Always PR** — never push directly to base branch
- **Per-repo concurrency** — repos run in parallel; each repo defaults to one active run
- **Orchestrator owns verification** — never trust agent claims that tests pass
- **Forge abstraction** — GitHub first, Forgejo second via `ForgeAdapter` interface
- **Review gates readiness** — PR only marked ready when reviewer approves AND verify passes
