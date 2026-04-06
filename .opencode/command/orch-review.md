---
description: Review code changes against the night-orch 8-point checklist
---

# /orch-review — Review Code Changes

Review current changes against night-orch conventions using the 8-point checklist.

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

2. **Load reference**: Read `.claude/skills/code-review/skill.md` for the 8-point checklist.

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

5. **Security spot-check**: If changes touch `src/workers/` or `src/forge/`, read `.claude/skills/security-review/skill.md` and run the security-specific checks.

6. **Self-review pass**: Do a second pass focusing on security, immutability, and edge cases. If external review tools are available, consult them for a second opinion.

7. **Synthesize**: Combine findings into a unified report.

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
| 1 | RunContext immutability | pass/fail | ... |
| ... | ... | ... | ... |

### Security (if applicable)
[Findings from security-review skill]

### Verdict
APPROVE / REQUEST CHANGES / NEEDS DISCUSSION

### Action Items
- [ ] ...
```
