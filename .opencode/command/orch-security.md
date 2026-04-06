---
description: Security audit — scan for token leaks, env isolation violations, prompt injection vectors
---

# /orch-security — Security Audit

Run a comprehensive security audit of the night-orch codebase.

## Process

1. **Load reference**: Read `.claude/skills/security-review/skill.md` for the full audit checklist.

2. **Token leak scan**:
   ```bash
   # Find all token/secret references
   rg -n 'TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH' src/ --type ts -g '!*.d.ts' -g '!*.test.ts'

   # Check for process.env in workers (should only be in env.ts)
   rg -n 'process\.env' src/workers/ --type ts

   # Check for direct Octokit usage outside forge/
   rg -n 'Octokit|octokit' src/ --type ts -g '!src/forge/*'
   ```

3. **Worker environment audit**:
   - Read `src/workers/env.ts` (if exists)
   - Verify `buildWorkerEnv()` uses whitelist approach
   - Check no sensitive vars in whitelist

4. **Prompt injection scan**:
   ```bash
   # Find raw issue content usage in prompts
   rg -n 'issue\.(title|body|content)' src/workers/ --type ts

   # Check for sanitizer usage
   rg -n 'sanitize' src/workers/prompt/ --type ts
   ```

5. **Logging audit**:
   ```bash
   # Find console.log usage (should use pino)
   rg -n 'console\.(log|warn|error|info|debug)' src/ --type ts

   # Check pino redaction config
   rg -n 'redact' src/ --type ts
   ```

6. **Report**: For each area, report PASS / FAIL / NOT YET IMPLEMENTED with specific findings.

## Output Format

```markdown
## Security Audit Report

### Token Isolation
Status: PASS/FAIL/NOT IMPLEMENTED
Findings: ...

### Worker Environment
Status: PASS/FAIL/NOT IMPLEMENTED
Findings: ...

### Prompt Injection Defense
Status: PASS/FAIL/NOT IMPLEMENTED
Findings: ...

### Logging & Redaction
Status: PASS/FAIL/NOT IMPLEMENTED
Findings: ...

### Summary
Critical: X | Warning: X | Info: X
```
