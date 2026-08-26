---
name: orch-grilling
description: Grill the user relentlessly about a plan, decision, feature, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

## Read the altitude first

Before the first question, decide what you are grilling. The ask tells you; nobody needs to name a mode.

**Product altitude** — a direction, a problem, a "should we", a slice with no shape yet. The root decisions are the outcome, whose problem it solves, what is deliberately out of scope, and what would make it not worth building. Do not descend into schema, endpoints or components until the shape is settled: a premature interface question makes the user design a thing they have not yet agreed to build.

**Feature altitude** — a named thing with a known place in the product. The root decisions are observable behaviour, the states and edges it must survive, its contract with its neighbours, and how it fails. Assume the product framing and do not relitigate it.

Most sessions start high and descend. When an answer moves the altitude, follow it, say so in a line, and keep going. When the ask is genuinely ambiguous, take the reading you find most likely, state it in one sentence, and let the user correct it in their first answer. Never open by asking which mode this is.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

## In this project

Facts about the codebase are yours to find: the loop engine, the config schema, the TUI, the specs
under `docs/`, the ADRs in `docs/adr/`, and the rules in `.claude/rules/`. Credentials and the
contents of orchestrated repositories are not — `.claude/rules/01-security.md` governs that
boundary.

**This session writes no ADR.** A decision that earns one is recorded by the change that implements
it, in the same commit as the code; an ADR written here would describe a system that does not exist
yet. Carry the settled decisions into the issue instead.

Never invent an answer to your own question in order to close the frontier. An unanswered question
stays open.

This produces shared understanding only: no code, no plan file, no ledger, and no ticket. Your
recommended answers are not approval.

When the frontier is empty and the user confirms, hand the settled decisions to `orch-work`.

Grilling method from mattpocock/skills (MIT).
