---
name: worker-adapter
description: WorkerAdapter interface, prompt compilation, output parsing, timeout handling, env isolation
---

# Worker Adapter Skill

Workers are external AI processes (Claude Code, Codex) that night-orch spawns to do actual coding work. They are the most security-sensitive part of the system.

## Architecture

```
Loop Coordinator → Prompt Compiler → Worker Adapter → Output Parser
                   (workers/prompt/)   (workers/)      (workers/parsers/)
```

- **Prompt Compiler**: Assembles system + user prompts from templates. Sanitizes issue content.
- **Worker Adapter**: Spawns the worker process with isolated env. Handles timeouts.
- **Output Parser**: Validates and extracts structured data from worker responses.

## Environment Isolation (CRITICAL)

Workers MUST receive a minimal environment via `buildWorkerEnv()`:

```typescript
// src/workers/env.ts
const ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'NODE_ENV'] as const;

export function buildWorkerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  return env;
}
```

**NEVER**:
- Pass `process.env` directly to a worker
- Add `*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*` vars to the whitelist
- Pass forge credentials to workers

## Prompt Compilation

- Templates live in `workers/prompt/`
- Issue content (title, body) is **attacker-controlled** — always sanitize:
  - Strip code fences that could confuse the worker
  - Strip HTML tags
  - Truncate to reasonable length
  - Never place issue content in system prompt — always in user prompt

## Output Parsing

- Parsers live in `workers/parsers/`
- Validate structure before acting on content
- Reject malformed responses — don't try to salvage
- Extract: plan text, code diff, review verdict, file changes

## Timeout Handling

- Every worker call has a timeout (configurable, default ~5 min)
- On timeout: kill process, log event, return timeout error
- `decide()` handles timeout errors (may retry or stop)

## When Working on Worker Code

1. Read `src/workers/env.ts` first — understand the whitelist
2. Check `docs/specs-active/phase-04-workers.md` for spec
3. Any new env var for workers needs security justification
4. Test prompt compilation with adversarial issue content
5. Test output parsing with malformed/incomplete responses
