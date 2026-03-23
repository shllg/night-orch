# night-orch

A self-hosted Node.js/TypeScript CLI that autonomously processes GitHub/Forgejo issues using AI agents (Claude Code, Codex CLI). Runs overnight or unattended — discovers issues, plans, codes, reviews, and opens PRs.

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
night-orch run              # long-running poller
night-orch run-once         # single poll + process cycle
night-orch doctor           # validate config, auth, binaries, repos
night-orch sync             # reconcile local state with GitHub
night-orch retry <repo> <#> # force re-run of one issue
night-orch labels-init [repo] # create/update orchestration labels via gh CLI
night-orch cleanup          # remove stale worktrees, leases, logs
night-orch notify-test      # send test notification
night-orch mcp              # start MCP server (stdio)
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
- **Serial processing** in v1 — one issue at a time
- **Orchestrator owns verification** — never trust agent claims that tests pass
- **Forge abstraction** — GitHub first, Forgejo second via `ForgeAdapter` interface
- **Review gates readiness** — PR only marked ready when reviewer approves AND verify passes
