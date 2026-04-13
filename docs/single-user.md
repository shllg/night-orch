# Single-User Deployment

Night-orch is usually described as having a "bot" that drives work and "humans" who review it. In a single-user deployment the two are the same person: you run night-orch under your own GitHub account (your personal access token), and every comment, review, and PR it produces is authored by you.

This page documents how that setup works, what counts as human feedback when the bot and the human share an identity, and the rules that make it unambiguous.

## When to use it

- You are the sole operator of a personal repo (or a repo where you are the only collaborator night-orch needs to impersonate).
- You do not want to create, manage, or pay for a separate GitHub account just to act as the bot.
- You are comfortable that every interaction night-orch makes will be attributed to you in the UI and audit log.

If any of those don't hold, create a dedicated bot account and use its PAT — the codebase works identically, and multi-identity deployments avoid the ambiguity this page has to work around.

## How night-orch tells itself apart

Night-orch never identifies its own content by GitHub author. Instead, every comment it writes carries an HTML marker:

```
<!-- night-orch:status -->
```

The marker kind (`status`, `plan`, …) varies by comment purpose, but the prefix `<!-- night-orch:` is constant. Filtering on that prefix — not on the author — lets the reaction scanner and comment-command parser distinguish bot-authored content from your own, even when both live under the same GitHub identity.

Night-orch does **not** post PR reviews or inline PR review comments. Only issue comments are ever machine-authored. That means reviews and inline review comments can be treated as human input unconditionally.

## What gets picked up automatically

Once a run reaches `review_ready`, the reaction scanner polls the PR every `github.pollIntervalSeconds` (default 300 s). On the next cycle after you leave feedback, night-orch transitions the run back to `queued` and kicks off a follow-up attempt with your feedback seeded as context. The following inputs trigger a reaction automatically:

- A PR review with state **Changes requested**, with or without a body.
- A PR review with state **Commented** and a non-empty body.
- A new inline PR review comment.
- A failing CI check (transition from non-failure to failure).
- A merge conflict (transition from mergeable to conflicting).

You do not have to toggle a label, post an `/orch continue`, or restart anything. The only requirement is that your feedback was posted *after* the run entered `review_ready`.

## What does **not** trigger anything

- A PR review with state **Commented** and an empty body. That's a no-op review on GitHub and night-orch treats it the same way.
- Any content that contains the `<!-- night-orch:` marker. That's reserved for bot-authored comments.
- `/orch` commands inside fenced or indented code blocks. They're stripped before parsing so pasted terminal output doesn't accidentally run commands.
- Unrecognized verbs. Only `continue`, `retry`, `rebase`, and `cancel` are valid.

## `/orch` commands

You can post `/orch …` in any of three places:

| Source | Example |
|---|---|
| Issue comment (on the issue backing the run) | A normal conversation comment starting with `/orch continue` |
| PR review body | The top-level text you type when submitting a review |
| PR inline review comment | A threaded comment anchored to a specific file/line |

Supported verbs:

- `/orch continue` — queue a follow-up attempt that picks up from review_ready, seeded with any new reactions/comments.
- `/orch retry [--reset-plan]` — requeue the run from the planning phase. `--reset-plan` discards the previous plan output.
- `/orch rebase [--check]` — rebase the PR onto the latest base branch and rerun verify. `--check` (on by default) runs checks afterwards.
- `/orch cancel` — move a running or queued run to `blocked` and release its lease.

Comment-command execution is gated by the `commentCommands.requireCollaborator` config; in single-user deployments this is effectively a no-op (you are always a collaborator on your own repo), but it's a good idea to keep it enabled on any repo that accepts external PRs.

## Settling an existing stuck run

If you arrive at a run that's sitting in `review_ready` because it was created before this documented behavior existed (or under an older version of night-orch), any of the following will move it forward:

1. Post an issue comment on the backing issue with `/orch continue`.
2. Post a PR review with state "Changes requested" and a short description of what you want changed.
3. Click **Queue Continue Pass** from the run's detail view in the web dashboard.

All three paths converge on the same follow-up attempt.

## Related configuration

- `github.pollIntervalSeconds` — how often the reaction scanner runs. Default 300 s. Lower values shorten the gap between feedback and pickup at the cost of API quota.
- `commentCommands.enabled` — master switch for `/orch` parsing. Default `true`.
- `commentCommands.requireCollaborator` — if `true`, non-collaborators can't execute commands. Leave enabled on any repo that accepts external contributions.

See [`CONFIGURATION`](./CONFIGURATION.md) for the full schema.
