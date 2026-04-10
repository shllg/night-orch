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
