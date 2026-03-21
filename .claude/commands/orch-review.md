---
allowed-tools: Read, Glob, Grep, Bash, Agent, Task, TaskCreate, TaskUpdate, TaskList, mcp__codex__consult_codex
description: Review code changes against the night-orch 8-point checklist with codex second opinion
user-invocable: true
---

# /orch-review — Review Code Changes

Review current changes against night-orch conventions using the 8-point checklist, with a mandatory Codex second opinion.

## Input

$ARGUMENTS — optional: specific files or commit range to review (default: uncommitted changes)

## Process

1. **Get the diff**:
   ```bash
   # Uncommitted changes
   git diff
   git diff --staged
   # Or specific range
   git diff main...HEAD
   ```

2. **Load the code-review skill** for the 8-point checklist.

3. **Walk each changed file** against the checklist:
   - RunContext immutability
   - ForgeAdapter boundary
   - Worker environment isolation
   - Phase checkpointing
   - Metrics best-effort
   - Label idempotency
   - Error handling
   - TypeScript strictness

4. **Run automated checks**:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

5. **Security spot-check**: If changes touch `src/workers/` or `src/forge/`, load the `security-review` skill and run the security-specific checks.

6. **Codex second opinion (MANDATORY)**: Send the diff to `mcp__codex__consult_codex` for external review.

7. **Synthesize**: Combine your findings with Codex's into a unified report.

## Output Format

```markdown
## Review: [branch or description]

### Automated Checks
- Typecheck: PASS/FAIL
- Lint: PASS/FAIL
- Tests: PASS/FAIL

### 8-Point Checklist
| # | Check | Status | Notes |
|---|-------|--------|-------|
| 1 | RunContext immutability | ✅/❌ | ... |
| ... | ... | ... | ... |

### Security (if applicable)
[Findings from security-review skill]

### Codex Review
[Summary of external review]

### Verdict
APPROVE / REQUEST CHANGES / NEEDS DISCUSSION

### Action Items
- [ ] ...
```
