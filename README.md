# night-orch

[![CI](https://github.com/shllg/night-orch/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/shllg/night-orch/actions/workflows/ci.yml)
[![Docs](https://github.com/shllg/night-orch/actions/workflows/docs.yml/badge.svg?branch=master)](https://github.com/shllg/night-orch/actions/workflows/docs.yml)

Night-orch is a self-hosted orchestrator that watches GitHub/Forgejo issues, runs AI agents to implement changes, verifies the result, and opens pull requests.

It is designed for unattended operation: label an issue, let the orchestrator execute your workflow, and review the resulting PR.

## Quick Start

### 1. Prerequisites

- Node.js 24+
- GitHub or Forgejo repositories with local git clones
- One or more worker CLIs (for example `codex` and/or `claude`)

### 2. Install

```bash
npm install -g night-orch
```

### 3. Initialize and validate

```bash
night-orch init
night-orch doctor
night-orch labels-init
```

### 4. Start orchestration

```bash
night-orch run
```

In another terminal, monitor progress:

```bash
night-orch tui
# or
night-orch web
```

For mobile or server-hosted setups, use an external terminal client such as Terminus. The web UI no longer embeds a browser shell.

### 5. Queue work

Add the ready label (default: `orch:ready`) to an issue in a configured repository. Night-orch will pick it up on the next poll cycle and run the Plan -> Code -> Verify -> Review loop.

## Configure with an AI agent

Don't want to read the docs? Spin up a coding agent (Claude Code, Codex, etc.) in your project directory and paste the prompt below. It fetches the official docs, interviews you about your setup, writes a `config.yaml`, and validates it with `night-orch doctor`.

````text
You are configuring **night-orch**, an autonomous issue→PR orchestrator, for my project.

FIRST, read the official documentation so your config matches the current schema — do not guess keys:
- Configuration reference: https://shllg.github.io/night-orch/CONFIGURATION
- Usage guide:             https://shllg.github.io/night-orch/USAGE
- Overview / concepts:     https://shllg.github.io/night-orch/OVERVIEW
Fetch these pages (web/fetch tool) before writing anything. If you cannot reach them, stop and tell me.

THEN interview me — ask these one or two at a time, infer sensible answers from my repo where you can (read package.json / Gemfile / mise.toml / CI config / existing branches), and confirm before writing:
1. Which repo(s) should it work on? (owner/name + local checkout path)
2. Forge: GitHub or Forgejo? (Forgejo needs apiBaseUrl + token env var)
3. Base branch and branch prefix? (default base `main`, prefix `orch`)
4. Which label marks an issue "ready to implement"? (default `orch:ready`)
5. Worker per role — planner / coder / reviewer: `claude`, `codex`, or `opencode`?
   (Proven default: planner=claude, coder=codex, reviewer=codex.)
6. Verify commands that must pass before a PR is opened (lint, typecheck, tests, build).
   Detect them from my project; ask if unsure. Consider a staged `verificationProfile`
   (smoke → targeted → full) for slow suites.
7. Environment: does a run need services (DB, redis)? shared vs dedicated docker-compose,
   and any bootstrap commands (install deps, prepare DB)?
8. Billing model: `subscription` (Claude Code / Codex flat plan — real cost is $0 and that
   is correct), `pay-per-use`, or `subscription-metered`. If subscription, set non-cost
   runaway limits (`loop.maxAttemptChainLength`, `loop.maxIssueTokens`, `loop.maxRunWallClockMinutes`)
   instead of relying on USD caps, and optionally `cost.subscriptionQuota` to detect overflow.
9. Reliability: enable the preflight drift gate (`repos[].preflight`) so a red base branch
   skips the batch instead of failing every issue? Set `security.maxChangedFiles` scope guard.

RULES:
- Produce a single valid `config.yaml` (or a project-local `.night-orch.yml`) using ONLY keys
  that exist in the Configuration reference you fetched.
- Explain each non-default choice in one line as a YAML comment.
- Do NOT put tokens in the file — reference env var names only (e.g. `tokenEnv: GITHUB_TOKEN`).
- After writing, run `night-orch doctor` (or `mise run doctor`) and fix anything it reports.
- Finish by telling me how to queue work: add the ready label to an issue, then `night-orch run`.
````

## Core Commands

```bash
night-orch run                      # long-running poller daemon
night-orch run-once                 # execute one poll cycle
night-orch status                   # current runs and recent activity
night-orch tui                      # terminal dashboard
night-orch web                      # browser UI + API
night-orch retry <repo> <issue>     # start fresh from the latest base branch
night-orch continue <repo> <issue>  # resume the existing branch with fresh PR context
night-orch rebase <repo> <issue>    # queue an explicit rebase + verify pass
night-orch labels-init              # create/update required labels
```

## Documentation

- Overview: https://shllg.github.io/night-orch/OVERVIEW
- Usage guide: https://shllg.github.io/night-orch/USAGE
- Configuration reference: https://shllg.github.io/night-orch/CONFIGURATION
- Deployment guide: https://shllg.github.io/night-orch/deployment
- Docs home: https://shllg.github.io/night-orch/

## Contributing

Development setup, architecture guardrails, and contribution workflow live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE).
