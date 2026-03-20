# Phase 4: Worker Adapters + Triage + Sandboxing

## Objective

Implement Claude Code and Codex CLI worker adapters, prompt compilation from templates + runtime data, structured output parsing, and worker environment isolation. After this phase, planner/coder/reviewer roles can each execute via either adapter with timeouts and minimal env.

## Dependencies

- **Phase 3**: Worktree exists with correct branch, environment set up.
- **Phase 2**: Issue metadata and resolved roles available.
- **Phase 1**: Config (workerProfiles), logger.

## Inputs

- Worker profile config (command, args, env, timeout, runtimeWrapper)
- Worktree path (cwd for worker execution)
- Role-specific data: issue body, plan, review findings, verify results, iteration metadata
- Prompt templates from repo config or defaults

## Outputs

- `WorkerAdapter` interface with Claude and Codex implementations
- Prompt compiler: templates + runtime data → final prompt
- Structured output parsers for planner, coder, and reviewer contracts
- Worker execution with timeout, process group kill, and env isolation
- Triage-adjusted parameters (iteration limits based on complexity)

---

## Interfaces / Types

### WorkerAdapter

```typescript
interface WorkerAdapter {
  /** Execute a task in the given role. */
  runTask(input: WorkerTaskInput): Promise<WorkerTaskResult>;

  /** Check if the worker CLI is available. Used by `doctor`. */
  checkAvailability(): Promise<{ available: boolean; version: string | null }>;
}

interface WorkerTaskInput {
  role: 'planner' | 'coder' | 'reviewer';
  worktreePath: string;
  prompt: string;
  profile: WorkerProfile;
  timeoutSeconds: number;
  /** Env vars to pass. Already filtered by isolation logic. */
  env: Record<string, string>;
}

interface WorkerTaskResult {
  rawOutput: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** Parsed by role-specific parser after adapter returns. */
  parsed: PlannerOutput | CoderOutput | ReviewerOutput | null;
  parseError: string | null;
}

interface WorkerProfile {
  type: 'claude' | 'codex';
  command: string;
  args: string[];
  workerTimeoutSeconds: number;
  minimalEnv: boolean;
  runtimeWrapper: string | null;
  env: Record<string, string>;
}
```

### Prompt Compiler

```typescript
interface PromptContext {
  role: 'planner' | 'coder' | 'reviewer';
  issue: {
    number: number;
    title: string;
    body: string;
    labels: string[];
  };
  repo: {
    name: string;
    baseBranch: string;
  };
  plan: string | null;
  reviewFindings: ReviewFinding[] | null;
  verifyResults: VerifyResult[] | null;
  iteration: {
    current: number;
    max: number;
    isRetry: boolean;
  };
  triageLevel: TriageLevel;
}

interface CompiledPrompt {
  systemPrompt: string;
  userPrompt: string;
}

/** Compile a prompt from template file + runtime context.
 *  Templates use {{variable}} syntax.
 *  System prompt loaded from file path in config.
 *  User prompt assembled from structured context. */
function compilePrompt(
  templatePath: string | null,
  defaultTemplate: string,
  context: PromptContext
): CompiledPrompt;
```

### Output Parsers

```typescript
// --- Planner ---
interface PlannerOutput {
  objective: string;
  assumptions: string[];
  filesToChange: string[];
  steps: PlanStep[];
  risks: string[];
  testStrategy: string;
}

interface PlanStep {
  order: number;
  description: string;
  files: string[];
}

// --- Coder ---
interface CoderOutput {
  summary: string;
  changedFiles: string[];
  remainingUncertainty: string | null;
  blockers: string[] | null;
}

// --- Reviewer ---
type ReviewVerdict = 'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED';

interface ReviewerOutput {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  definitionOfDoneCheck: {
    issueAddressed: boolean;
    testsPassing: boolean;
    noBlockingFindings: boolean;
  };
}

interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor';
  message: string;
  suggestedFix: string | null;
}

/** Parse raw worker output into structured type.
 *  Looks for JSON blocks fenced with ```json ... ``` or
 *  structured markers like <!-- PLAN_START --> ... <!-- PLAN_END -->.
 *  Returns null with parseError if not parseable. */
function parsePlannerOutput(raw: string): PlannerOutput | null;
function parseCoderOutput(raw: string): CoderOutput | null;
function parseReviewerOutput(raw: string): ReviewerOutput | null;
```

### Environment Isolation

```typescript
/** Build the env vars to pass to a worker process.
 *  NEVER passes full process.env.
 *  NEVER passes GITHUB_TOKEN or any forge token.
 *
 *  Whitelist:
 *  - PATH, HOME, USER, SHELL, LANG, TERM
 *  - XDG_* dirs
 *  - Worker profile's explicit env overrides
 *  - Explicitly listed env vars from config
 */
function buildWorkerEnv(profile: WorkerProfile): Record<string, string>;

const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
] as const;

const ENV_BLACKLIST = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'FORGEJO_TOKEN',
  'NIGHT_ORCH_WEBHOOK_URL',
  /.*_SECRET$/,
  /.*_KEY$/,
  /.*_PASSWORD$/,
] as const;
```

### Triage Adjustments

```typescript
interface TriageAdjustedLimits {
  maxReviewIterations: number;
  maxTotalAgentPasses: number;
  workerTimeoutSeconds: number;
}

/** Adjust loop/timeout limits based on triage level.
 *  - trivial: halve iterations, 60% timeout
 *  - standard: use config values as-is
 *  - architectural: 1.5x iterations, 1.5x timeout (capped at absolute max) */
function adjustLimitsForTriage(
  baseLimits: LoopConfig,
  triage: TriageResult,
  absoluteMax: { iterations: number; timeout: number }
): TriageAdjustedLimits;
```

---

## Config Schema Additions

No new top-level fields. Uses existing `workerProfiles` from Phase 1 config. The `minimalEnv` and `runtimeWrapper` fields are already defined.

---

## Files to Create

```
src/
  workers/
    types.ts               — WorkerAdapter, WorkerTaskInput, WorkerTaskResult, output types
    claude.ts              — ClaudeWorkerAdapter
    codex.ts               — CodexWorkerAdapter
    factory.ts             — createWorkerAdapter(profile) → WorkerAdapter
    env.ts                 — buildWorkerEnv(), ENV_WHITELIST, ENV_BLACKLIST
    timeout.ts             — execWithTimeout() using execa + process group kill
    prompt/
      compiler.ts          — compilePrompt() with template loading and variable substitution
      templates/
        planner-default.md — default planner system prompt
        coder-default.md   — default coder system prompt
        reviewer-default.md — default reviewer system prompt
    parsers/
      planner.ts           — parsePlannerOutput()
      coder.ts             — parseCoderOutput()
      reviewer.ts          — parseReviewerOutput()
      extract.ts           — extractJsonBlock(), extractMarkedSection() utilities
  discovery/
    triage.ts              — (update) add adjustLimitsForTriage()
```

### File Descriptions

- **`workers/types.ts`**: All worker-related interfaces and types. No implementation.
- **`workers/claude.ts`**: `ClaudeWorkerAdapter`. Invokes `claude -p <prompt> --output-format json` (or configured args) in the worktree cwd. Streams output to log. Captures full output for parsing. Uses `--allowedTools` to restrict dangerous operations.
- **`workers/codex.ts`**: `CodexWorkerAdapter`. Invokes `codex exec --json <prompt>` (or configured args). Parses JSON output. Captures structured result.
- **`workers/factory.ts`**: Creates adapter based on `profile.type`. Throws for unknown types.
- **`workers/env.ts`**: Env isolation logic. Builds minimal env from whitelist + profile overrides. Rejects any blacklisted var. Logs a warning if a blacklisted var was in the profile's env config.
- **`workers/timeout.ts`**: `execWithTimeout(command, args, opts)` using `execa`. Sets `timeout` option. On timeout, kills the entire process group (`killSignal: 'SIGKILL'`, `forceKillAfterDelay: 5000`). Returns `{ stdout, stderr, exitCode, timedOut, durationMs }`.
- **`workers/prompt/compiler.ts`**: Loads template from file path or falls back to default. Substitutes `{{issue.title}}`, `{{plan}}`, `{{reviewFindings}}`, etc. Sanitizes issue body to prevent prompt injection (strips HTML tags, truncates to max length).
- **`workers/prompt/templates/*.md`**: Default prompt templates. Structured with clear output format instructions including JSON fences.
- **`workers/parsers/planner.ts`**: Extracts JSON from planner output. Falls back to heuristic section parsing.
- **`workers/parsers/coder.ts`**: Extracts summary and changed files from coder output.
- **`workers/parsers/reviewer.ts`**: Extracts JSON verdict block. Validates verdict is one of the allowed keywords. Strict: if not parseable and `blockOnAmbiguousReview` is true, returns null with parse error.
- **`workers/parsers/extract.ts`**: Shared utilities: `extractJsonBlock(raw)` finds first ` ```json ... ``` ` block, `extractMarkedSection(raw, startMarker, endMarker)` finds content between markers.

---

## Worker Execution Flow

1. **Build env**: `buildWorkerEnv(profile)` → minimal, safe env
2. **Compile prompt**: `compilePrompt(templatePath, defaultTemplate, context)` → system + user prompt
3. **Build command**: Assemble CLI command from profile (command, args) + role-specific flags
4. **Execute**: `execWithTimeout(command, args, { cwd: worktreePath, env, timeout })`
5. **Parse output**: Role-specific parser extracts structured result
6. **Return**: `WorkerTaskResult` with raw output, exit code, parsed result (or parse error)

### Claude-Specific

```bash
claude -p "$(cat prompt.txt)" \
  --output-format json \
  --max-turns 50 \
  --allowedTools "Edit,Write,Read,Bash(git diff:*),Bash(git status:*)" \
  2>&1
```

- The `-p` flag runs in non-interactive/print mode
- `--output-format json` gives structured response
- Prompt is passed via stdin or temp file to avoid shell escaping issues

### Codex-Specific

```bash
codex exec "$(cat prompt.txt)" \
  --json \
  2>&1
```

- `exec` runs in non-interactive mode
- `--json` gives structured output

---

## Tests

### Worker Env Tests (`test/workers/env.test.ts`)
- Whitelist: PATH, HOME included
- Blacklist: GITHUB_TOKEN, GH_TOKEN excluded even if in profile env
- Regex blacklist: `MY_SECRET`, `API_KEY` excluded
- Profile env overrides added (non-blacklisted)
- `minimalEnv: false` passes full process.env (minus blacklist) — NOT recommended but supported

### Prompt Compiler Tests (`test/workers/prompt/compiler.test.ts`)
- Template variables substituted correctly
- Missing template file falls back to default
- Issue body sanitized: HTML tags stripped
- Issue body truncated at max length
- All PromptContext fields accessible in template
- Review findings formatted as numbered list
- Verify results formatted with pass/fail indicators

### Parser Tests (`test/workers/parsers/`)
- **Planner**: valid JSON block parsed correctly
- **Planner**: missing JSON → heuristic section extraction
- **Coder**: summary and changed files extracted
- **Reviewer**: valid JSON verdict parsed, all three verdict types
- **Reviewer**: ambiguous output → null with parse error
- **Extract**: `extractJsonBlock` finds JSON in markdown fences
- **Extract**: multiple JSON blocks → first one used
- **Extract**: malformed JSON → null

### Timeout Tests (`test/workers/timeout.test.ts`)
- Command completes within timeout → normal result
- Command exceeds timeout → killed, `timedOut: true`
- Process group killed (not just parent)

### Triage Adjustment Tests (`test/discovery/triage.test.ts`)
- Trivial: iterations halved
- Standard: no change
- Architectural: iterations increased, capped at absolute max

### Integration Test (`test/workers/adapter.test.ts`)
- Mock CLI execution for both Claude and Codex
- Full flow: compile prompt → execute → parse → return structured result
- Timeout scenario handled correctly

---

## Acceptance Criteria

1. `ClaudeWorkerAdapter` and `CodexWorkerAdapter` can execute in any of the three roles
2. Worker env never contains `GITHUB_TOKEN` or other forge tokens
3. Worker env whitelist limits exposure to minimal required vars
4. Prompts are compiled from templates with all runtime context substituted
5. Planner, coder, and reviewer outputs are parsed into structured types
6. Unparseable reviewer output is treated as failure when `blockOnAmbiguousReview` is true
7. Worker timeout kills entire process group after `workerTimeoutSeconds`
8. Triage level adjusts iteration and timeout limits
9. Default prompt templates are included and produce valid prompts
10. All tests pass: `pnpm test`
