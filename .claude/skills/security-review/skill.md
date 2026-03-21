---
name: security-review
description: Security audit for night-orch — token flow, worker isolation, prompt injection, logging redaction
---

# Night-Orch Security Review

This is the highest-priority review skill. Night-orch handles GitHub/Forgejo tokens and spawns AI worker processes — security mistakes can leak credentials or allow prompt injection attacks.

## Audit Areas

### 1. Token Flow Audit
- Trace every use of `GITHUB_TOKEN`, `FORGEJO_TOKEN`, and any `*_TOKEN` env var
- Verify tokens are ONLY accessed in:
  - `src/forge/github.ts`
  - `src/forge/forgejo.ts`
  - `src/config/` (loading from env/config file)
- Verify tokens are NEVER in: worker processes, log output, error messages, prompts

### 2. Worker Environment Isolation
- Read `src/workers/env.ts` — verify `buildWorkerEnv()` implementation
- Check `ENV_WHITELIST` contains only safe vars
- Grep for `process.env` in `src/workers/` — should only appear in `env.ts`
- Verify no worker adapter passes additional env vars outside the whitelist

### 3. Prompt Injection Defense
- Check `src/workers/prompt/sanitize.ts` exists and is called before prompt compilation
- Verify issue title/body are sanitized in all prompt templates
- Check for raw string interpolation of issue content in prompts
- Verify worker output parsers validate structure before acting on content

### 4. Pino Redaction
- Check logger configuration for redaction paths
- Required paths: `['*.token', '*.apiKey', '*.secret', '*.password', '*.authorization']`
- Verify no `console.log` usage (grep for it)
- Check error handlers don't log full request/response objects

### 5. `buildWorkerEnv()` Correctness
- Whitelist approach (not blacklist) — only explicitly listed vars pass through
- No glob patterns that could match sensitive vars
- `PATH` and `HOME` are the only system vars that should pass through

## Commands

```bash
# Find all token references
rg -n 'TOKEN|SECRET|KEY|PASSWORD' src/ --type ts -g '!*.d.ts'

# Find process.env usage in workers
rg -n 'process\.env' src/workers/

# Find console.log usage
rg -n 'console\.(log|warn|error|info)' src/ --type ts

# Find raw issue content interpolation
rg -n 'issue\.(title|body|content)' src/workers/prompt/ --type ts
```

## Output Format

For each area, report: PASS / FAIL / NOT YET IMPLEMENTED
If FAIL, list specific file:line and the violation.
