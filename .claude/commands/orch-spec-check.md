---
allowed-tools: Read, Glob, Grep
description: Verify implementation matches spec — reads phase spec, checks acceptance criteria
user-invocable: true
---

# /orch-spec-check — Verify Spec Compliance

Check whether the current implementation matches a spec's acceptance criteria.

## Input

$ARGUMENTS — phase number or name (e.g., "4", "phase-04", "workers")

## Process

1. **Find the spec**: Search `docs/specs-active/` for the matching phase spec. Read it fully.

2. **Extract acceptance criteria**: Pull out every acceptance criterion and required file/interface from the spec.

3. **Check each criterion**:

   For **"file X exists"** criteria:
   ```
   Glob for the file path. Report exists/missing.
   ```

   For **"interface X has field Y"** criteria:
   ```
   Read the file, check the interface definition.
   ```

   For **"function X does Y"** criteria:
   ```
   Read the implementation, verify the behavior matches.
   ```

   For **"test X passes"** criteria:
   ```
   Check the test file exists and covers the criterion.
   ```

4. **Report**:

## Output Format

```markdown
## Spec Check: Phase [N] — [Name]

### Spec: docs/specs-active/phase-NN-name.md

### Acceptance Criteria
| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | ... | ✅/❌/⚠️ | ... |
| 2 | ... | ✅/❌/⚠️ | ... |

### Missing Files
- [ ] src/path/to/expected/file.ts

### Missing Interfaces/Types
- [ ] InterfaceName in src/path/file.ts

### Missing Tests
- [ ] test/path/expected.test.ts

### Summary
Implemented: X/Y criteria
Remaining: [list of what's left to do]
```
