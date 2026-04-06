---
description: Plan a night-orch feature or phase implementation with spec review
---

# /orch-plan — Plan Feature or Phase

Plan an implementation for night-orch. Reads the relevant spec, analyzes the codebase, and produces a structured plan.

## Input

$ARGUMENTS — description of the feature or phase to plan (e.g., "phase 4 workers", "add Forgejo rate limiting")

## Process

1. **Identify the relevant spec**: Search `docs/specs-active/` for the matching phase spec. Read it fully.

2. **Analyze current state**: Check what already exists in the codebase related to this feature:
   - `pnpm typecheck` — does the project currently compile?
   - Glob for existing files in the relevant `src/` directories
   - Read key interfaces and types that will be touched

3. **Load reference materials**: Based on the feature area, read the appropriate skill files:
   - Workers → `.claude/skills/worker-adapter/skill.md` + `.claude/skills/security-review/skill.md`
   - Loop → `.claude/skills/loop-engine/skill.md`
   - Forge → `.claude/skills/forge-adapter/skill.md`
   - Config/Types → `.claude/skills/typescript-patterns/skill.md`

4. **Draft the plan**: Structure as:
   - **Goal**: One sentence
   - **Spec reference**: Which spec file and section
   - **Files to create/modify**: List with brief description of changes
   - **Interfaces**: Key types that will be defined or changed
   - **Security considerations**: Token handling, env isolation, prompt injection
   - **Test plan**: What tests to write, what to mock
   - **Acceptance criteria**: From the spec, plus any additional

5. **External review (recommended)**: If external review tools are available, consult them for a second opinion. Otherwise, perform a self-review pass checking for missed edge cases and security gaps.

6. **Present to user**: Show the final plan. Ask for approval before any implementation.

## Output Format

```markdown
## Plan: [Feature Name]

### Goal
[One sentence]

### Spec Reference
[File path and section]

### Changes
| File | Action | Description |
|------|--------|-------------|
| ... | create/modify | ... |

### Key Interfaces
[TypeScript interface definitions]

### Security Considerations
[Bullet points]

### Test Plan
[What to test, what to mock]

### Acceptance Criteria
- [ ] ...

### Review Notes
[Self-review or external review summary]
```
