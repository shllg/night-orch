---
name: codex-review
description: Second-opinion workflow — own analysis first, then Codex MCP review, then synthesize
---

# Codex Review Workflow

Use this skill to get an external second opinion from Codex on plans, code changes, or architecture decisions.

## Process

### Step 1: Own Analysis First
Before calling Codex, form your own assessment:
- What are the changes/plan?
- What are the risks?
- What would you flag in a review?

Write down your findings — do NOT skip this step.

### Step 2: Invoke Codex MCP
Call `mcp__codex__consult_codex` with a focused prompt:

```
Review the following [plan/changes/code] for a TypeScript CLI tool (night-orch) that orchestrates AI workers to process GitHub/Forgejo issues.

Key constraints:
- RunContext must be immutable (no mutations)
- Worker processes must NEVER receive forge tokens
- All forge operations through ForgeAdapter interface
- Phase checkpointing required for crash recovery
- Metrics must be best-effort (never block/throw)

[Paste the specific content to review]

Focus on: correctness, security, missed edge cases, and adherence to the constraints above.
```

### Step 3: Synthesize
Compare your analysis with Codex's response:
- Where do you agree? → High-confidence findings
- Where does Codex flag something you missed? → Investigate further
- Where do you disagree with Codex? → Explain your reasoning
- Where Codex is uncertain? → Flag for user decision

### Output Format
Present a unified review with:
1. **Agreed findings** (both you and Codex flagged)
2. **Codex-only findings** (worth investigating)
3. **Your-only findings** (Codex missed)
4. **Disagreements** (with reasoning)
5. **Recommendation**: approve / request changes / needs discussion

## Notes
- Codex may timeout — if it does, present your own analysis and note the timeout
- Never send actual tokens or secrets to Codex
- This skill satisfies the review-gate hook requirement for exiting plan mode
