---
allowed-tools: Read, Glob, Grep, Bash, Agent, Task, TaskCreate, TaskUpdate, TaskList, WebFetch, WebSearch, mcp__codex__consult_codex, mcp__gemini__gemini-query, mcp__gemini__gemini-analyze-code, AskUserQuestion
description: Plan a night-orch feature or phase implementation with spec review and codex second opinion
user-invocable: true
---

# /orch-plan — Plan Feature or Phase

Plan an implementation for night-orch. Reads the relevant spec, analyzes the codebase, and produces a structured plan with mandatory external review.

## Input

$ARGUMENTS — description of the feature or phase to plan (e.g., "phase 4 workers", "add Forgejo rate limiting")

## Process

1. **Identify the relevant spec**: Search `docs/specs-active/` for the matching phase spec. Read it fully.

2. **Analyze current state**: Check what already exists in the codebase related to this feature:
   - `pnpm typecheck` — does the project currently compile?
   - Glob for existing files in the relevant `src/` directories
   - Read key interfaces and types that will be touched

3. **Load relevant skills**: Based on the feature area, invoke the appropriate skill:
   - Workers → `worker-adapter` + `security-review`
   - Loop → `loop-engine`
   - Forge → `forge-adapter`
   - Config/Types → `typescript-patterns`

4. **Draft the plan**: Structure as:
   - **Goal**: One sentence
   - **Spec reference**: Which spec file and section
   - **Files to create/modify**: List with brief description of changes
   - **Interfaces**: Key types that will be defined or changed
   - **Security considerations**: Token handling, env isolation, prompt injection
   - **Test plan**: What tests to write, what to mock
   - **Acceptance criteria**: From the spec, plus any additional

5. **External review (MANDATORY)**: Call `mcp__codex__consult_codex` with the draft plan for a second opinion. Synthesize feedback.

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

### External Review
[Codex feedback summary]
```
