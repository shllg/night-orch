# Security Rules

These rules are MANDATORY. Security violations in night-orch can leak tokens to AI workers or expose repos to prompt injection.

## Token Isolation

- **NEVER pass `GITHUB_TOKEN`** (or any forge token) to worker processes
- **NEVER pass `process.env`** to workers — use `buildWorkerEnv()` which applies a strict whitelist
- Workers get only: `PATH`, `HOME`, `LANG`, `NODE_ENV`, and explicitly listed tool paths
- If adding a new env var to workers, update `ENV_WHITELIST` in `src/workers/env.ts` and document why

## ENV_BLACKLIST

These patterns must NEVER appear in worker environments:
- `*TOKEN*`, `*SECRET*`, `*KEY*` (except `NODE_ENV`)
- `*PASSWORD*`, `*CREDENTIAL*`, `*AUTH*`
- `GITHUB_*`, `FORGEJO_*`, `GH_*`

## Prompt Injection Defense

- Issue titles and bodies are **attacker-controlled** — sanitize before prompt compilation
- Strip code fences, HTML tags, and excessive whitespace from issue content
- Never interpolate raw issue content into system prompts — use the sanitizer in `workers/prompt/sanitize.ts`
- Validate worker output before acting on it — parsers must reject malformed responses

## Logging & Redaction

- pino redaction paths: `['*.token', '*.apiKey', '*.secret', '*.password', '*.authorization']`
- NEVER log full request/response bodies from forge API calls — log status codes and summary only
- NEVER log environment variables — log only the variable names, not values
- Use structured logging with `runId`, `repo`, `issueNumber` fields

## Code Review Checklist (Security)

When touching `src/workers/`:
1. Does the change add any new env vars to the worker process?
2. Does `buildWorkerEnv()` still exclude all sensitive vars?
3. Is issue content sanitized before prompt compilation?
4. Are worker outputs validated before being used?

When touching `src/forge/`:
1. Are tokens only accessed within the forge adapter?
2. Are API responses logged safely (no token leakage)?
3. Are error messages sanitized before logging?
