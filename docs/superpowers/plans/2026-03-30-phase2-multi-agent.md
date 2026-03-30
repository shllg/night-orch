# Phase 2: Multi-Agent Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add agent-agnostic adapter registry with ACP support, task decomposition for composite issues, parallel sub-task execution in isolated worktrees, and active worker supervision.

**Architecture:** Four independent modules built bottom-up: (1) adapter registry + ACP adapter replaces the hardcoded factory, (2) decomposer uses existing planner adapter to split issues, (3) parallel executor creates worktree-per-subtask with topological wave scheduling, (4) supervisor adds timer-based stuck detection around worker invocations.

**Tech Stack:** TypeScript ESM, acpx (ACP protocol), better-sqlite3, vitest, zod, execa

---

### Task 1: Worker Adapter Registry

**Files:**
- Create: `src/workers/registry.ts`
- Create: `test/workers/registry.test.ts`
- Modify: `src/workers/types.ts`
- Modify: `src/workers/factory.ts`
- Modify: `src/config/schema.ts`

- [ ] **Step 1: Write registry tests**

Create `test/workers/registry.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { WorkerAdapterRegistry } from '../../src/workers/registry.js'
import type { WorkerAdapter, WorkerProfileInput } from '../../src/workers/types.js'

function makeMockAdapter(): WorkerAdapter {
  return {
    runTask: vi.fn().mockResolvedValue({
      rawOutput: '', exitCode: 0, timedOut: false, durationMs: 0,
      parsed: null, parseError: null, sessionId: null,
    }),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
  }
}

describe('WorkerAdapterRegistry', () => {
  it('creates adapter for registered type', () => {
    const registry = new WorkerAdapterRegistry()
    const adapter = makeMockAdapter()
    registry.register('test', () => adapter)

    const profile = { type: 'test', command: 'test', args: [], workerTimeoutSeconds: 60, minimalEnv: true, runtimeWrapper: null, env: {} } as WorkerProfileInput

    expect(registry.create(profile)).toBe(adapter)
  })

  it('throws for unregistered type', () => {
    const registry = new WorkerAdapterRegistry()
    const profile = { type: 'unknown', command: 'x', args: [], workerTimeoutSeconds: 60, minimalEnv: true, runtimeWrapper: null, env: {} } as WorkerProfileInput

    expect(() => registry.create(profile)).toThrow('No adapter registered for worker type "unknown"')
  })

  it('lists registered types', () => {
    const registry = new WorkerAdapterRegistry()
    registry.register('claude', () => makeMockAdapter())
    registry.register('codex', () => makeMockAdapter())

    expect(registry.getRegisteredTypes()).toEqual(['claude', 'codex'])
  })

  it('prevents duplicate registration', () => {
    const registry = new WorkerAdapterRegistry()
    registry.register('claude', () => makeMockAdapter())

    expect(() => registry.register('claude', () => makeMockAdapter())).toThrow('already registered')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run test/workers/registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Update `WorkerProfileInput.type` to `string`**

In `src/workers/types.ts`, change line 18:

```typescript
export interface WorkerProfileInput {
  type: string
  command: string
  // ... rest unchanged
}
```

In `src/config/schema.ts`, change the WorkerProfileSchema type field:

```typescript
const WorkerProfileSchema = z.object({
  type: z.string().min(1, 'Worker type must not be empty'),
  // ... rest unchanged
})
```

- [ ] **Step 4: Add `tokenUsage` to `WorkerTaskResult`**

In `src/workers/types.ts`, add after `sessionId`:

```typescript
export interface WorkerTaskResult {
  // ... existing fields ...
  sessionId: string | null
  /** Real token counts from the agent, when available. */
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
  }
}
```

- [ ] **Step 5: Implement the registry**

Create `src/workers/registry.ts`:

```typescript
import type { WorkerAdapter, WorkerProfileInput } from './types.js'

export type WorkerAdapterFactory = (profile: WorkerProfileInput) => WorkerAdapter

export class WorkerAdapterRegistry {
  private factories = new Map<string, WorkerAdapterFactory>()

  register(type: string, factory: WorkerAdapterFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`Worker adapter type "${type}" is already registered`)
    }
    this.factories.set(type, factory)
  }

  create(profile: WorkerProfileInput): WorkerAdapter {
    const factory = this.factories.get(profile.type)
    if (!factory) {
      const known = [...this.factories.keys()].join(', ')
      throw new Error(
        `No adapter registered for worker type "${profile.type}". Registered types: ${known}`,
      )
    }
    return factory(profile)
  }

  getRegisteredTypes(): string[] {
    return [...this.factories.keys()]
  }
}
```

- [ ] **Step 6: Update factory to use registry**

Replace `src/workers/factory.ts`:

```typescript
import type { WorkerAdapter, WorkerProfileInput } from './types.js'
import { WorkerAdapterRegistry } from './registry.js'
import { ClaudeWorkerAdapter } from './claude.js'
import { CodexWorkerAdapter } from './codex.js'

const defaultRegistry = new WorkerAdapterRegistry()
defaultRegistry.register('claude', () => new ClaudeWorkerAdapter())
defaultRegistry.register('codex', () => new CodexWorkerAdapter())

export function createWorkerAdapter(profile: WorkerProfileInput): WorkerAdapter {
  return defaultRegistry.create(profile)
}

export { defaultRegistry }
```

- [ ] **Step 7: Run tests**

Run: `pnpm typecheck && pnpm test`
Expected: All 751+ tests pass

- [ ] **Step 8: Commit**

```bash
git add src/workers/registry.ts src/workers/factory.ts src/workers/types.ts src/config/schema.ts test/workers/registry.test.ts
git commit -m "[FEATURE] Add WorkerAdapterRegistry with plugin pattern"
```

---

### Task 2: Token-Based Cost Tracking

**Files:**
- Modify: `src/loop/engine.ts`
- Modify: `test/loop/engine.test.ts`

- [ ] **Step 1: Write test for token-based cost**

Add to `test/loop/engine.test.ts` in the `executeLoop` describe block:

```typescript
it('uses token-based cost when available', async () => {
  const plannerResult = {
    ...makePlannerResult(),
    tokenUsage: { promptTokens: 1000, completionTokens: 500 },
  }
  const deps: LoopDependencies = {
    db,
    config: makeConfig(),
    plannerAdapter: makeMockAdapter([plannerResult]),
    coderAdapter: makeMockAdapter([makeCoderResult()]),
    reviewerAdapter: makeMockAdapter([makeReviewerResult('APPROVED')]),
  }

  const result = await executeLoop(makeCtx(), deps)

  // Token-based cost should be > 0 (1500 tokens * rate)
  expect(result.estimatedCostUsd).toBeGreaterThan(0)
  expect(result.terminalStatus).toBe('publish')
})
```

- [ ] **Step 2: Run test to verify it fails or passes with time-based estimate**

Run: `pnpm test -- --run test/loop/engine.test.ts`

- [ ] **Step 3: Update `applyEstimatedWorkerCost` to prefer token usage**

In `src/loop/engine.ts`, replace the `applyEstimatedWorkerCost` function:

```typescript
// Approximate per-token rates (USD) — Claude Sonnet-class pricing
const ESTIMATED_USD_PER_INPUT_TOKEN = 0.000003
const ESTIMATED_USD_PER_OUTPUT_TOKEN = 0.000015

const ESTIMATED_USD_PER_MINUTE: Record<'planner' | 'coder' | 'reviewer', number> = {
  planner: 0.008,
  coder: 0.008,
  reviewer: 0.008,
}

function applyEstimatedWorkerCost(
  ctx: RunContext,
  costTracker: CostTracker,
  role: 'planner' | 'coder' | 'reviewer',
  durationMs: number,
  tokenUsage?: { promptTokens: number; completionTokens: number },
): RunContext {
  let estimatedCost: number
  if (tokenUsage) {
    estimatedCost = Number((
      tokenUsage.promptTokens * ESTIMATED_USD_PER_INPUT_TOKEN +
      tokenUsage.completionTokens * ESTIMATED_USD_PER_OUTPUT_TOKEN
    ).toFixed(6))
  } else {
    const rate = ESTIMATED_USD_PER_MINUTE[role]
    estimatedCost = Number(((durationMs / 60_000) * rate).toFixed(6))
  }
  estimatedCost = Math.max(0, estimatedCost)
  if (estimatedCost <= 0) return ctx
  costTracker.recordCost(ctx.runId, estimatedCost)
  return updateContext(ctx, {
    estimatedCostUsd: Number((ctx.estimatedCostUsd + estimatedCost).toFixed(6)),
  })
}
```

- [ ] **Step 4: Update all `applyEstimatedWorkerCost` call sites to pass `tokenUsage`**

In the plan, code, and review steps, the worker result is available. Update each call:

After `runPlanStep`:
```typescript
ctx = applyEstimatedWorkerCost(ctx, costTracker, 'planner', planDurationMs, result.tokenUsage)
```

But `result` is not in scope at the call site — it's inside `runPlanStep`. Instead, have `runPlanStep`/`runCodeStep`/`runReviewStep` return the result alongside the context. Simpler approach: store `tokenUsage` on the context temporarily.

Actually the simplest approach: have `runWorkerStep` return the full result, and let the callers pass `result.tokenUsage` to `applyEstimatedWorkerCost`. The plan/code/review steps already call `runWorkerStep` and have the result. Update each:

In `runPlanStep`, after `const result = await runWorkerStep(...)`:
```typescript
// already returns result to the caller via plan/code/review step functions
```

In the main loop where `applyEstimatedWorkerCost` is called, we need the result. Refactor: have `runPlanStep` return `{ ctx, tokenUsage }`:

```typescript
async function runPlanStep(ctx: RunContext, deps: LoopDependencies): Promise<{ ctx: RunContext; tokenUsage?: WorkerTaskResult['tokenUsage'] }> {
  const result = await runWorkerStep(...)
  return {
    ctx: updateContext(ctx, {
      plan: result.parsed as RunContext['plan'],
      totalAgentPasses: ctx.totalAgentPasses + 1,
      sessionIds: result.sessionId ? { ...ctx.sessionIds, planner: result.sessionId } : ctx.sessionIds,
    }),
    tokenUsage: result.tokenUsage,
  }
}
```

Apply the same pattern to `runCodeStep` and `runReviewStep`. Then in `executeLoop`:

```typescript
const planResult = await runPlanStep(ctx, deps)
ctx = planResult.ctx
ctx = applyEstimatedWorkerCost(ctx, costTracker, 'planner', planDurationMs, planResult.tokenUsage)
```

- [ ] **Step 5: Run tests**

Run: `pnpm typecheck && pnpm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/loop/engine.ts test/loop/engine.test.ts
git commit -m "[FEATURE] Prefer token-based cost tracking when adapter provides token counts"
```

---

### Task 3: ACP Worker Adapter

**Files:**
- Create: `src/workers/acp.ts`
- Create: `test/workers/acp.test.ts`
- Modify: `src/workers/factory.ts`

- [ ] **Step 1: Install acpx**

Run: `pnpm add acpx`

- [ ] **Step 2: Write ACP adapter tests**

Create `test/workers/acp.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AcpWorkerAdapter } from '../../src/workers/acp.js'
import type { WorkerTaskInput, WorkerProfileInput } from '../../src/workers/types.js'

// Mock acpx session runtime
vi.mock('acpx/dist/session-runtime.js', () => ({
  runOnce: vi.fn(),
  sendSessionDirect: vi.fn(),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { runOnce, sendSessionDirect } from 'acpx/dist/session-runtime.js'

const mockRunOnce = vi.mocked(runOnce)
const mockSendSessionDirect = vi.mocked(sendSessionDirect)

const acpProfile: WorkerProfileInput = {
  type: 'acp',
  command: 'codex',
  args: [],
  workerTimeoutSeconds: 60,
  minimalEnv: true,
  runtimeWrapper: null,
  env: {},
}

function makeInput(overrides: Partial<WorkerTaskInput> = {}): WorkerTaskInput {
  return {
    role: 'planner',
    worktreePath: '/tmp/wt',
    prompt: 'Plan the fix',
    profile: acpProfile,
    timeoutSeconds: 60,
    env: { PATH: '/usr/bin' },
    ...overrides,
  }
}

describe('AcpWorkerAdapter', () => {
  let adapter: AcpWorkerAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new AcpWorkerAdapter()
  })

  it('calls runOnce for fresh invocations', async () => {
    mockRunOnce.mockResolvedValue({
      stopReason: 'end_turn',
      sessionId: 'ses-123',
      permissionStats: {},
    })

    const result = await adapter.runTask(makeInput())

    expect(mockRunOnce).toHaveBeenCalledTimes(1)
    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe('ses-123')
  })

  it('calls sendSessionDirect when continueSessionId is provided', async () => {
    mockSendSessionDirect.mockResolvedValue({
      stopReason: 'end_turn',
      permissionStats: {},
      sessionId: 'ses-123',
      record: {},
      resumed: true,
    })

    const result = await adapter.runTask(makeInput({ continueSessionId: 'ses-123' }))

    expect(mockSendSessionDirect).toHaveBeenCalledTimes(1)
    expect(mockRunOnce).not.toHaveBeenCalled()
  })

  it('falls back to runOnce when session resume fails', async () => {
    mockSendSessionDirect.mockRejectedValue(new Error('session not found'))
    mockRunOnce.mockResolvedValue({
      stopReason: 'end_turn',
      sessionId: 'ses-new',
      permissionStats: {},
    })

    const result = await adapter.runTask(makeInput({ continueSessionId: 'ses-old' }))

    expect(mockSendSessionDirect).toHaveBeenCalledTimes(1)
    expect(mockRunOnce).toHaveBeenCalledTimes(1)
    expect(result.sessionId).toBe('ses-new')
  })

  it('maps timeout to timedOut flag', async () => {
    const timeoutError = new Error('timeout')
    ;(timeoutError as Record<string, unknown>)['outputCode'] = 'TIMEOUT'
    mockRunOnce.mockRejectedValue(timeoutError)

    const result = await adapter.runTask(makeInput())

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(1)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- --run test/workers/acp.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement ACP adapter**

Create `src/workers/acp.ts`:

```typescript
import type { WorkerAdapter, WorkerTaskInput, WorkerTaskResult } from './types.js'
import { parsePlannerOutput } from './parsers/planner.js'
import { parseCoderOutput } from './parsers/coder.js'
import { parseReviewerOutput } from './parsers/reviewer.js'
import { logger } from '../utils/logger.js'

export class AcpWorkerAdapter implements WorkerAdapter {
  async runTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
    const start = Date.now()
    let assistantText = ''
    let sessionId: string | null = null
    let exitCode = 0
    let timedOut = false
    let tokenUsage: { promptTokens: number; completionTokens: number } | undefined

    // Collect text from session update events
    const textParts: string[] = []
    const onSessionUpdate = (notification: Record<string, unknown>): void => {
      if (notification['type'] === 'text' && typeof notification['text'] === 'string') {
        textParts.push(notification['text'] as string)
      }
    }

    try {
      if (input.continueSessionId) {
        try {
          const result = await this.sendSessionDirect(input, onSessionUpdate)
          sessionId = result.sessionId
          assistantText = textParts.join('')
        } catch (resumeErr) {
          logger.warn({ role: input.role, err: resumeErr }, 'Session resume failed — falling back to runOnce')
          textParts.length = 0
          const result = await this.runOnceCall(input, onSessionUpdate)
          sessionId = result.sessionId
          assistantText = textParts.join('')
        }
      } else {
        const result = await this.runOnceCall(input, onSessionUpdate)
        sessionId = result.sessionId
        assistantText = textParts.join('')
      }
    } catch (err) {
      const durationMs = Date.now() - start
      if (isAcpTimeout(err)) {
        timedOut = true
      }
      exitCode = 1
      logger.error({ role: input.role, err }, 'ACP worker failed')
      return {
        rawOutput: assistantText || textParts.join(''),
        exitCode,
        timedOut,
        durationMs,
        parsed: null,
        parseError: String(err),
        sessionId,
        tokenUsage,
      }
    }

    const durationMs = Date.now() - start

    // If no text collected via events, the output may be in the raw result
    if (!assistantText) {
      assistantText = textParts.join('') || ''
    }

    logger.info(
      { role: input.role, textLength: assistantText.length, sessionId, durationMs },
      'ACP worker completed',
    )

    const { parsed, parseError } = parseOutput(input.role, assistantText)

    return {
      rawOutput: assistantText,
      exitCode,
      timedOut,
      durationMs,
      parsed,
      parseError,
      sessionId,
      tokenUsage,
    }
  }

  private async runOnceCall(
    input: WorkerTaskInput,
    onSessionUpdate: (n: Record<string, unknown>) => void,
  ): Promise<{ sessionId: string | null; stopReason: string }> {
    // Dynamic import to avoid hard dependency if acpx is not installed
    const { runOnce } = await import('acpx/dist/session-runtime.js')

    const result = await (runOnce as (opts: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      agentCommand: input.profile.command,
      cwd: input.worktreePath,
      prompt: input.prompt,
      permissionMode: 'approve-all',
      nonInteractivePermissions: 'deny',
      timeoutMs: input.timeoutSeconds * 1000,
      onSessionUpdate,
      sessionOptions: { maxTurns: 50 },
    })

    return {
      sessionId: typeof result['sessionId'] === 'string' ? result['sessionId'] : null,
      stopReason: typeof result['stopReason'] === 'string' ? result['stopReason'] : 'unknown',
    }
  }

  private async sendSessionDirect(
    input: WorkerTaskInput,
    onSessionUpdate: (n: Record<string, unknown>) => void,
  ): Promise<{ sessionId: string | null; stopReason: string }> {
    const { sendSessionDirect } = await import('acpx/dist/session-runtime.js')

    const result = await (sendSessionDirect as (opts: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      sessionId: input.continueSessionId,
      prompt: input.prompt,
      permissionMode: 'approve-all',
      onSessionUpdate,
      timeoutMs: input.timeoutSeconds * 1000,
    })

    return {
      sessionId: typeof result['sessionId'] === 'string' ? result['sessionId'] : null,
      stopReason: typeof result['stopReason'] === 'string' ? result['stopReason'] : 'unknown',
    }
  }

  async checkAvailability(): Promise<{ available: boolean; version: string | null }> {
    try {
      await import('acpx/dist/session-runtime.js')
      return { available: true, version: null }
    } catch {
      return { available: false, version: null }
    }
  }
}

function isAcpTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  return (err as Record<string, unknown>)['outputCode'] === 'TIMEOUT'
}

function parseOutput(role: string, raw: string): { parsed: WorkerTaskResult['parsed']; parseError: string | null } {
  switch (role) {
    case 'planner': {
      const { result, error } = parsePlannerOutput(raw)
      return { parsed: result, parseError: error }
    }
    case 'coder': {
      const { result, error } = parseCoderOutput(raw)
      return { parsed: result, parseError: error }
    }
    case 'reviewer': {
      const { result, error } = parseReviewerOutput(raw)
      return { parsed: result, parseError: error }
    }
    default:
      return { parsed: null, parseError: `Unknown role: ${role}` }
  }
}
```

- [ ] **Step 5: Register ACP adapter in factory**

In `src/workers/factory.ts`, add after the codex registration:

```typescript
import { AcpWorkerAdapter } from './acp.js'

defaultRegistry.register('acp', () => new AcpWorkerAdapter())
```

- [ ] **Step 6: Run tests**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/workers/acp.ts src/workers/factory.ts test/workers/acp.test.ts package.json pnpm-lock.yaml
git commit -m "[FEATURE] Add ACP worker adapter via acpx for agent-agnostic support"
```

---

### Task 4: Decomposer Parser

**Files:**
- Create: `src/workers/parsers/decomposer.ts`
- Create: `test/workers/parsers/decomposer.test.ts`

- [ ] **Step 1: Write decomposer parser tests**

Create `test/workers/parsers/decomposer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseDecomposerOutput } from '../../../src/workers/parsers/decomposer.js'

describe('parseDecomposerOutput', () => {
  it('parses valid decomposition with subtasks', () => {
    const raw = '```json\n' + JSON.stringify({
      shouldDecompose: true,
      reasoning: 'This issue has two independent parts',
      subtasks: [
        { title: 'Add API endpoint', description: 'Create /api/users', dependencies: [], estimatedComplexity: 'standard' },
        { title: 'Add tests', description: 'Test the endpoint', dependencies: [0], estimatedComplexity: 'trivial' },
      ],
    }) + '\n```'

    const { result, error } = parseDecomposerOutput(raw)

    expect(error).toBeNull()
    expect(result).not.toBeNull()
    expect(result!.shouldDecompose).toBe(true)
    expect(result!.subtasks).toHaveLength(2)
    expect(result!.subtasks[0]!.title).toBe('Add API endpoint')
    expect(result!.subtasks[1]!.dependencies).toEqual([0])
  })

  it('parses shouldDecompose=false', () => {
    const raw = '```json\n' + JSON.stringify({
      shouldDecompose: false,
      reasoning: 'This issue is already atomic',
      subtasks: [],
    }) + '\n```'

    const { result, error } = parseDecomposerOutput(raw)

    expect(error).toBeNull()
    expect(result!.shouldDecompose).toBe(false)
    expect(result!.subtasks).toEqual([])
  })

  it('falls back to no-decompose on parse failure', () => {
    const { result, error } = parseDecomposerOutput('Just some text')

    expect(result).not.toBeNull()
    expect(result!.shouldDecompose).toBe(false)
    expect(error).toContain('fallback')
  })

  it('caps subtasks at maxSubtasks', () => {
    const subtasks = Array.from({ length: 10 }, (_, i) => ({
      title: `Task ${i}`, description: `Desc ${i}`, dependencies: [], estimatedComplexity: 'standard',
    }))
    const raw = JSON.stringify({ shouldDecompose: true, reasoning: 'Many tasks', subtasks })

    const { result } = parseDecomposerOutput(raw, 5)

    expect(result!.subtasks).toHaveLength(5)
  })

  it('defaults estimatedComplexity to standard', () => {
    const raw = JSON.stringify({
      shouldDecompose: true,
      reasoning: 'Split it',
      subtasks: [{ title: 'A', description: 'B', dependencies: [] }],
    })

    const { result } = parseDecomposerOutput(raw)

    expect(result!.subtasks[0]!.estimatedComplexity).toBe('standard')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run test/workers/parsers/decomposer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement decomposer parser**

Create `src/workers/parsers/decomposer.ts`:

```typescript
import { parseJsonFromOutput } from './extract.js'
import { z } from 'zod'

export interface SubTask {
  title: string
  description: string
  dependencies: number[]
  estimatedComplexity: 'trivial' | 'standard'
}

export interface DecompositionResult {
  shouldDecompose: boolean
  subtasks: SubTask[]
  reasoning: string
}

const SubTaskSchema = z.object({
  title: z.string(),
  description: z.string(),
  dependencies: z.array(z.number().int().min(0)).default([]),
  estimatedComplexity: z.enum(['trivial', 'standard']).default('standard'),
}).passthrough()

const DecompositionSchema = z.object({
  shouldDecompose: z.boolean(),
  reasoning: z.string().default(''),
  subtasks: z.array(SubTaskSchema).default([]),
}).passthrough()

export function parseDecomposerOutput(
  raw: string,
  maxSubtasks = 5,
): { result: DecompositionResult | null; error: string | null } {
  const parsed = parseJsonFromOutput(raw)
  if (!parsed || typeof parsed !== 'object') {
    return {
      result: { shouldDecompose: false, subtasks: [], reasoning: '' },
      error: 'No JSON found in decomposer output — fallback to no decomposition',
    }
  }

  const validation = DecompositionSchema.safeParse(parsed)
  if (!validation.success) {
    return {
      result: { shouldDecompose: false, subtasks: [], reasoning: '' },
      error: `Decomposer output failed validation — fallback to no decomposition`,
    }
  }

  const result = validation.data
  if (result.subtasks.length > maxSubtasks) {
    result.subtasks = result.subtasks.slice(0, maxSubtasks)
  }

  return { result, error: null }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm test -- --run test/workers/parsers/decomposer.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/workers/parsers/decomposer.ts test/workers/parsers/decomposer.test.ts
git commit -m "[FEATURE] Add decomposer output parser with fallback to no-decompose"
```

---

### Task 5: Issue Decomposer

**Files:**
- Create: `src/discovery/decomposer.ts`
- Create: `test/discovery/decomposer.test.ts`
- Modify: `src/config/schema.ts`

- [ ] **Step 1: Add config fields**

In `src/config/schema.ts`, in the loop object schema, add after `maxAutoRetries`:

```typescript
decompose: z.boolean().default(false),
maxSubtasks: z.number().int().min(1).max(10).default(5),
maxConcurrentSubtasks: z.number().int().min(1).max(10).default(3),
```

- [ ] **Step 2: Write decomposer tests**

Create `test/discovery/decomposer.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { decomposeIssue, shouldAttemptDecompose } from '../../src/discovery/decomposer.js'
import type { ForgeIssue } from '../../src/forge/types.js'
import type { WorkerAdapter, WorkerTaskResult } from '../../src/workers/types.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeIssue(overrides: Partial<ForgeIssue> = {}): ForgeIssue {
  return {
    number: 1, nodeId: null, title: 'Complex issue', body: 'A'.repeat(600),
    labels: [], assignees: [], state: 'open', createdAt: '', updatedAt: '', url: '',
    ...overrides,
  }
}

function makeAdapter(result: Partial<WorkerTaskResult> = {}): WorkerAdapter {
  return {
    runTask: vi.fn().mockResolvedValue({
      rawOutput: '', exitCode: 0, timedOut: false, durationMs: 1000,
      parsed: null, parseError: null, sessionId: null,
      ...result,
    }),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, version: '1.0' }),
  }
}

describe('shouldAttemptDecompose', () => {
  it('returns true for long issue body', () => {
    expect(shouldAttemptDecompose(makeIssue())).toBe(true)
  })

  it('returns true for issue with 3+ numbered items', () => {
    const body = '1. First thing\n2. Second thing\n3. Third thing'
    expect(shouldAttemptDecompose(makeIssue({ body }))).toBe(true)
  })

  it('returns false for short issue', () => {
    expect(shouldAttemptDecompose(makeIssue({ body: 'Short bug' }))).toBe(false)
  })
})

describe('decomposeIssue', () => {
  it('returns decomposition from adapter output', async () => {
    const json = JSON.stringify({
      shouldDecompose: true,
      reasoning: 'Two parts',
      subtasks: [
        { title: 'Part A', description: 'Do A', dependencies: [], estimatedComplexity: 'standard' },
        { title: 'Part B', description: 'Do B', dependencies: [0], estimatedComplexity: 'trivial' },
      ],
    })
    const adapter = makeAdapter({ rawOutput: '```json\n' + json + '\n```' })

    const result = await decomposeIssue(
      makeIssue(), adapter,
      { type: 'claude', command: 'claude', args: [], workerTimeoutSeconds: 60, minimalEnv: true, runtimeWrapper: null, env: {} },
      { PATH: '/usr/bin' }, '/tmp/wt', 5,
    )

    expect(result.shouldDecompose).toBe(true)
    expect(result.subtasks).toHaveLength(2)
  })

  it('falls back to no-decompose on adapter error', async () => {
    const adapter = makeAdapter()
    ;(adapter.runTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))

    const result = await decomposeIssue(
      makeIssue(), adapter,
      { type: 'claude', command: 'claude', args: [], workerTimeoutSeconds: 60, minimalEnv: true, runtimeWrapper: null, env: {} },
      { PATH: '/usr/bin' }, '/tmp/wt', 5,
    )

    expect(result.shouldDecompose).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- --run test/discovery/decomposer.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement decomposer**

Create `src/discovery/decomposer.ts`:

```typescript
import type { ForgeIssue } from '../forge/types.js'
import type { WorkerAdapter, WorkerProfileInput } from '../workers/types.js'
import { parseDecomposerOutput, type DecompositionResult } from '../workers/parsers/decomposer.js'
import { buildWorkerEnv } from '../workers/env.js'
import { logger } from '../utils/logger.js'

const BODY_LENGTH_THRESHOLD = 500
const NUMBERED_ITEM_PATTERN = /^\s*\d+[\.\)]\s+/gm
const HEADING_PATTERN = /^#{1,3}\s+/gm

/**
 * Heuristic check: should we even ask the LLM to decompose this issue?
 */
export function shouldAttemptDecompose(issue: ForgeIssue): boolean {
  if (issue.body.trim().length >= BODY_LENGTH_THRESHOLD) return true

  const numberedItems = issue.body.match(NUMBERED_ITEM_PATTERN)
  if (numberedItems && numberedItems.length >= 3) return true

  const headings = issue.body.match(HEADING_PATTERN)
  if (headings && headings.length >= 3) return true

  return false
}

/**
 * Ask the planner adapter to decompose an issue into atomic sub-tasks.
 * Falls back to no-decomposition on any error.
 */
export async function decomposeIssue(
  issue: ForgeIssue,
  adapter: WorkerAdapter,
  profile: WorkerProfileInput,
  env: Record<string, string>,
  worktreePath: string,
  maxSubtasks: number,
): Promise<DecompositionResult> {
  const noDecompose: DecompositionResult = {
    shouldDecompose: false,
    subtasks: [],
    reasoning: 'Decomposition skipped or failed',
  }

  try {
    const result = await adapter.runTask({
      role: 'planner',
      worktreePath,
      prompt: buildDecomposePrompt(issue),
      profile,
      timeoutSeconds: Math.min(profile.workerTimeoutSeconds, 300),
      env,
    })

    if (result.exitCode !== 0 || result.timedOut) {
      logger.warn({ issueNumber: issue.number, exitCode: result.exitCode, timedOut: result.timedOut }, 'Decomposer worker failed')
      return noDecompose
    }

    const { result: parsed, error } = parseDecomposerOutput(result.rawOutput, maxSubtasks)
    if (error) {
      logger.info({ issueNumber: issue.number, error }, 'Decomposer parse note')
    }
    return parsed ?? noDecompose
  } catch (err) {
    logger.warn({ issueNumber: issue.number, err }, 'Decomposer failed — proceeding without decomposition')
    return noDecompose
  }
}

function buildDecomposePrompt(issue: ForgeIssue): string {
  return `You are a task decomposition assistant. Analyze this issue and determine if it should be split into smaller, independent sub-tasks.

## Issue #${issue.number}: ${issue.title}

${issue.body}

## Instructions

1. Decide if this issue should be decomposed (some issues are already atomic — that's fine)
2. If yes, split into 2-5 atomic sub-tasks that can be implemented independently
3. Each sub-task should be completable in a single coding session
4. Specify dependencies between sub-tasks (by index)

Output your analysis as JSON:

\`\`\`json
{
  "shouldDecompose": true,
  "reasoning": "Why this issue should/shouldn't be split",
  "subtasks": [
    {
      "title": "Short title",
      "description": "What to implement",
      "dependencies": [],
      "estimatedComplexity": "standard"
    }
  ]
}
\`\`\`

CRITICAL: Your response MUST end with exactly one \\\`\\\`\\\`json block.`
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm typecheck && pnpm test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/discovery/decomposer.ts src/config/schema.ts test/discovery/decomposer.test.ts
git commit -m "[FEATURE] Add issue decomposer for splitting composite issues into sub-tasks"
```

---

### Task 6: DB Migration for Parent Run

**Files:**
- Create: `src/state/migrations/006-parent-run.ts`
- Modify: `src/state/db.ts`
- Modify: `src/state/runs.ts`

- [ ] **Step 1: Create migration**

Create `src/state/migrations/006-parent-run.ts`:

```typescript
import type Database from 'better-sqlite3'

export function up(db: Database.Database): void {
  db.prepare('ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id)').run()
}
```

- [ ] **Step 2: Register migration in db.ts**

In `src/state/db.ts`, add:

```typescript
import { up as migration006 } from './migrations/006-parent-run.js'
```

Add to the MIGRATIONS array:

```typescript
{ version: 6, name: '006-parent-run', up: migration006 },
```

- [ ] **Step 3: Update RunRecord and RunManager**

In `src/state/runs.ts`, add `parentRunId` to `RunRecord`:

```typescript
export interface RunRecord {
  // ... existing fields ...
  blockReason: string | null
  parentRunId: string | null
}
```

Add `parentRunId` to `CreateRunParams`:

```typescript
export interface CreateRunParams {
  // ... existing fields ...
  parentRunId?: string | null
}
```

Update `create()` to include `parent_run_id`:

```typescript
create(params: CreateRunParams): RunRecord {
  const id = generateRunId()
  const now = new Date().toISOString()
  this.db.prepare(
    `INSERT INTO runs (id, repo, issue_number, issue_node_id, status, planner, coder, reviewer, parent_run_id, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, params.repo, params.issueNumber, params.issueNodeId, params.planner, params.coder, params.reviewer, params.parentRunId ?? null, now, now, now)
  return this.getById(id)!
}
```

Add `parentRunId` to `allowed` in `update()`:

```typescript
const allowed = [
  'status', 'iterationCount', 'currentPhase', 'phaseData',
  'endedAt', 'lastError', 'prNumber', 'branchName', 'branchSlug',
  'worktreePath', 'estimatedCostUsd', 'blockReason', 'parentRunId',
] as const
```

Add to `columnMap`:

```typescript
parentRunId: 'parent_run_id',
```

Add query for sub-runs:

```typescript
getSubRuns(parentRunId: string): RunRecord[] {
  const rows = this.db
    .prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at')
    .all(parentRunId) as RawRunRow[]
  return rows.map((r) => this.mapRow(r))
}
```

Update `mapRow` to include `parentRunId`:

```typescript
parentRunId: row.parent_run_id ?? null,
```

Add to `RawRunRow`:

```typescript
parent_run_id: string | null
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/state/migrations/006-parent-run.ts src/state/db.ts src/state/runs.ts
git commit -m "[FEATURE] Add parent_run_id to runs table for sub-task tracking"
```

---

### Task 7: Parallel Sub-Task Execution

**Files:**
- Create: `src/loop/parallel.ts`
- Create: `test/loop/parallel.test.ts`

- [ ] **Step 1: Write parallel execution tests**

Create `test/loop/parallel.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { topologicalWaves } from '../../src/loop/parallel.js'
import type { SubTask } from '../../src/workers/parsers/decomposer.js'

describe('topologicalWaves', () => {
  it('groups independent tasks into one wave', () => {
    const tasks: SubTask[] = [
      { title: 'A', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'B', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'C', description: '', dependencies: [], estimatedComplexity: 'standard' },
    ]

    const waves = topologicalWaves(tasks)

    expect(waves).toHaveLength(1)
    expect(waves[0]).toEqual([0, 1, 2])
  })

  it('respects dependency ordering', () => {
    const tasks: SubTask[] = [
      { title: 'A', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'B', description: '', dependencies: [0], estimatedComplexity: 'standard' },
      { title: 'C', description: '', dependencies: [1], estimatedComplexity: 'standard' },
    ]

    const waves = topologicalWaves(tasks)

    expect(waves).toHaveLength(3)
    expect(waves[0]).toEqual([0])
    expect(waves[1]).toEqual([1])
    expect(waves[2]).toEqual([2])
  })

  it('groups same-depth dependencies into same wave', () => {
    const tasks: SubTask[] = [
      { title: 'A', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'B', description: '', dependencies: [], estimatedComplexity: 'standard' },
      { title: 'C', description: '', dependencies: [0, 1], estimatedComplexity: 'standard' },
    ]

    const waves = topologicalWaves(tasks)

    expect(waves).toHaveLength(2)
    expect(waves[0]).toEqual([0, 1])
    expect(waves[1]).toEqual([2])
  })

  it('handles empty input', () => {
    expect(topologicalWaves([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run test/loop/parallel.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement parallel executor**

Create `src/loop/parallel.ts`:

```typescript
import type { SubTask } from '../workers/parsers/decomposer.js'
import type { RunContext } from './types.js'
import type { LoopDependencies } from './engine.js'
import { executeLoop } from './engine.js'
import { updateContext } from './context.js'
import { RunManager } from '../state/runs.js'
import { createWorktreeManager } from '../git/worktree.js'
import { buildWorktreePath } from '../git/slug.js'
import { branchName } from '../utils/ids.js'
import { logger } from '../utils/logger.js'

export interface SubTaskResult {
  index: number
  subtask: SubTask
  ctx: RunContext | null
  success: boolean
  error?: string
}

/**
 * Topological sort into waves: tasks in the same wave have no
 * inter-dependencies and can run concurrently.
 */
export function topologicalWaves(subtasks: SubTask[]): number[][] {
  if (subtasks.length === 0) return []

  const depths = new Array<number>(subtasks.length).fill(0)

  // BFS-style depth assignment
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < subtasks.length; i++) {
      const task = subtasks[i]!
      for (const dep of task.dependencies) {
        if (dep >= 0 && dep < subtasks.length) {
          const newDepth = (depths[dep] ?? 0) + 1
          if (newDepth > (depths[i] ?? 0)) {
            depths[i] = newDepth
            changed = true
          }
        }
      }
    }
  }

  // Group by depth
  const maxDepth = Math.max(...depths)
  const waves: number[][] = []
  for (let d = 0; d <= maxDepth; d++) {
    const wave: number[] = []
    for (let i = 0; i < depths.length; i++) {
      if (depths[i] === d) wave.push(i)
    }
    if (wave.length > 0) waves.push(wave)
  }

  return waves
}

/**
 * Execute subtasks in parallel waves, each in its own worktree.
 * Returns results for all subtasks.
 */
export async function executeParallelSubtasks(
  parentCtx: RunContext,
  subtasks: SubTask[],
  deps: LoopDependencies,
  maxConcurrent: number,
): Promise<SubTaskResult[]> {
  const waves = topologicalWaves(subtasks)
  const results: SubTaskResult[] = []
  const runManager = new RunManager(deps.db)
  const worktreeManager = createWorktreeManager()

  for (const wave of waves) {
    // Run tasks in this wave concurrently, up to maxConcurrent
    const chunks = chunkArray(wave, maxConcurrent)

    for (const chunk of chunks) {
      const promises = chunk.map(async (index) => {
        const subtask = subtasks[index]!
        const subBranch = `${parentCtx.branchName}-sub${index}`
        const subWorktreePath = buildWorktreePath(
          parentCtx.worktreePath + '-subs',
          parentCtx.repo,
          parentCtx.issueNumber * 100 + index,
        )

        try {
          // Create sub-run in DB
          const subRun = runManager.create({
            repo: parentCtx.repo,
            issueNumber: parentCtx.issueNumber,
            issueNodeId: parentCtx.issue.nodeId,
            planner: parentCtx.roles.planner,
            coder: parentCtx.roles.coder,
            reviewer: parentCtx.roles.reviewer,
            parentRunId: parentCtx.runId,
          })

          // Create worktree for this subtask
          await worktreeManager.ensure({
            repoLocalPath: parentCtx.repoConfig.localPath,
            baseBranch: parentCtx.repoConfig.baseBranch,
            branchName: subBranch,
            worktreePath: subWorktreePath,
            resetToBase: true,
          })

          // Build sub-context
          const subCtx: RunContext = {
            ...parentCtx,
            runId: subRun.id,
            branchName: subBranch,
            worktreePath: subWorktreePath,
            plan: null,
            codeResult: null,
            diff: null,
            verifyResults: [],
            reviewResult: null,
            reviewFindings: [],
            iteration: 1,
            totalAgentPasses: 0,
            estimatedCostUsd: 0,
            currentPhase: 'plan',
            terminalStatus: 'running',
            phaseHistory: [],
            sessionIds: {},
            issue: {
              ...parentCtx.issue,
              title: subtask.title,
              body: subtask.description,
            },
          }

          runManager.update(subRun.id, { status: 'running', branchName: subBranch, worktreePath: subWorktreePath })

          const finalCtx = await executeLoop(subCtx, deps)
          const success = finalCtx.terminalStatus === 'publish'

          runManager.update(subRun.id, {
            status: success ? 'review_ready' : 'blocked',
            endedAt: new Date().toISOString(),
          })

          return { index, subtask, ctx: finalCtx, success }
        } catch (err) {
          logger.error({ index, title: subtask.title, err }, 'Sub-task execution failed')
          return { index, subtask, ctx: null, success: false, error: String(err) }
        }
      })

      const waveResults = await Promise.allSettled(promises)
      for (const settled of waveResults) {
        if (settled.status === 'fulfilled') {
          results.push(settled.value)
        } else {
          logger.error({ err: settled.reason }, 'Sub-task promise rejected unexpectedly')
        }
      }
    }
  }

  return results
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/loop/parallel.ts test/loop/parallel.test.ts
git commit -m "[FEATURE] Add parallel sub-task execution with topological wave scheduling"
```

---

### Task 8: Worker Supervisor

**Files:**
- Create: `src/loop/supervisor.ts`
- Create: `test/loop/supervisor.test.ts`
- Modify: `src/loop/engine.ts`

- [ ] **Step 1: Write supervisor tests**

Create `test/loop/supervisor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { superviseWorker } from '../../src/loop/supervisor.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { logger } from '../../src/utils/logger.js'

describe('superviseWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires warning at 80% of timeout', () => {
    const onStuck = vi.fn()
    const handle = superviseWorker('coder', 10_000, onStuck)

    vi.advanceTimersByTime(8_000)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'coder' }),
      expect.stringContaining('may be stuck'),
    )
    expect(onStuck).not.toHaveBeenCalled()

    handle.cancel()
  })

  it('fires onStuck at full timeout', () => {
    const onStuck = vi.fn()
    superviseWorker('coder', 10_000, onStuck)

    vi.advanceTimersByTime(10_000)
    expect(onStuck).toHaveBeenCalledTimes(1)
  })

  it('does not fire after cancel', () => {
    const onStuck = vi.fn()
    const handle = superviseWorker('coder', 10_000, onStuck)

    handle.cancel()
    vi.advanceTimersByTime(15_000)
    expect(onStuck).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run test/loop/supervisor.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement supervisor**

Create `src/loop/supervisor.ts`:

```typescript
import { logger } from '../utils/logger.js'

export interface SupervisorHandle {
  cancel(): void
}

/**
 * Timer-based worker supervision.
 * Logs a warning at 80% of timeout, calls onStuck at 100%.
 */
export function superviseWorker(
  role: string,
  timeoutMs: number,
  onStuck: () => void,
): SupervisorHandle {
  const warningMs = Math.floor(timeoutMs * 0.8)

  const warningTimer = setTimeout(() => {
    logger.warn({ role, timeoutMs, elapsedMs: warningMs }, `${role} worker may be stuck — approaching timeout`)
  }, warningMs)

  const stuckTimer = setTimeout(() => {
    logger.error({ role, timeoutMs }, `${role} worker appears stuck — triggering timeout`)
    onStuck()
  }, timeoutMs)

  return {
    cancel() {
      clearTimeout(warningTimer)
      clearTimeout(stuckTimer)
    },
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- --run test/loop/supervisor.test.ts`
Expected: All pass

- [ ] **Step 5: Integrate supervisor into engine**

In `src/loop/engine.ts`, import the supervisor:

```typescript
import { superviseWorker } from './supervisor.js'
```

In `runWorkerStep`, wrap the `adapter.runTask()` call:

```typescript
// Before the existing adapter.runTask call, add:
const supervisor = superviseWorker(role, ctx.adjustedLimits.workerTimeoutSeconds * 1000, () => {
  // The timeout.ts layer handles actual SIGTERM — this is advisory logging
})

try {
  const result = await adapter.runTask({ /* existing args */ })
  supervisor.cancel()
  // ... rest of existing code
} catch (err) {
  supervisor.cancel()
  throw err
}
```

- [ ] **Step 6: Run full test suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/loop/supervisor.ts src/loop/engine.ts test/loop/supervisor.test.ts
git commit -m "[FEATURE] Add timer-based worker supervision with stuck detection"
```

---

### Task 9: Poller Integration

**Files:**
- Modify: `src/runner/poller.ts`
- Modify: `src/publishing/pr-body.ts`

- [ ] **Step 1: Integrate decomposer into poller**

In `src/runner/poller.ts`, add imports:

```typescript
import { decomposeIssue, shouldAttemptDecompose } from '../discovery/decomposer.js'
import { executeParallelSubtasks } from '../loop/parallel.js'
```

In the issue processing loop (inside the `try` block, after creating `initialCtx` and before `executeLoop`), add decomposition logic:

```typescript
// Check if decomposition is enabled and appropriate
const shouldDecompose = config.loop.decompose
  && discoveredIssue.triage.level === 'standard'
  && shouldAttemptDecompose(discoveredIssue.issue)

if (shouldDecompose) {
  logger.info({ repo: repoConfig.repo, issue: discoveredIssue.issue.number }, 'Attempting issue decomposition')
  const decomposition = await decomposeIssue(
    discoveredIssue.issue,
    createWorkerAdapter(plannerProfile),
    plannerProfile,
    buildWorkerEnv(plannerProfile, envSetup?.envOverrides ?? {}),
    worktreePath,
    config.loop.maxSubtasks,
  )

  if (decomposition.shouldDecompose && decomposition.subtasks.length > 1) {
    logger.info(
      { repo: repoConfig.repo, issue: discoveredIssue.issue.number, subtasks: decomposition.subtasks.length },
      'Decomposed issue into sub-tasks — executing in parallel',
    )

    const subResults = await executeParallelSubtasks(
      initialCtx,
      decomposition.subtasks,
      { db, config, plannerAdapter: createWorkerAdapter(plannerProfile), coderAdapter: createWorkerAdapter(coderProfile), reviewerAdapter: createWorkerAdapter(reviewerProfile), envOverrides: envSetup?.envOverrides ?? {}, metrics },
      config.loop.maxConcurrentSubtasks,
    )

    const allSucceeded = subResults.every((r) => r.success)
    if (allSucceeded) {
      // All sub-tasks succeeded — publish combined PR
      // (For now, each subtask is on its own branch. The parent handles publishing.)
      runManager.update(run.id, { status: 'review_ready', endedAt: new Date().toISOString() })
      // Label transition and notification
      const latestIssue = await forge.getIssue(repoConfig.repo, discoveredIssue.issue.number)
      await transitionLabels(forge, repoConfig.repo, discoveredIssue.issue.number, latestIssue.labels, 'running', 'review_ready', labelConfig)
      await notifier.dispatch(makePayload('pr_ready', repoConfig.repo, discoveredIssue.issue, {
        summary: `Decomposed into ${decomposition.subtasks.length} sub-tasks, all completed`,
      }))
      processed++
    } else {
      const failed = subResults.filter((r) => !r.success).length
      runManager.update(run.id, { status: 'blocked', lastError: `${failed}/${decomposition.subtasks.length} sub-tasks failed`, endedAt: new Date().toISOString() })
      const latestIssue = await forge.getIssue(repoConfig.repo, discoveredIssue.issue.number)
      await transitionLabels(forge, repoConfig.repo, discoveredIssue.issue.number, latestIssue.labels, 'running', 'blocked', labelConfig)
      errors++
    }
    continue  // Skip the normal executeLoop path
  }
}

// Normal single-issue execution (existing code)
```

Add the necessary import for `buildWorkerEnv`:

```typescript
import { buildWorkerEnv } from '../workers/env.js'
```

- [ ] **Step 2: Update PR body for decomposed issues**

In `src/publishing/pr-body.ts`, add to `PRBodyContext`:

```typescript
export interface PRBodyContext {
  // ... existing fields ...
  subtaskSummaries?: { title: string; summary: string; success: boolean }[]
}
```

In `compilePRBody`, after the review section and before metadata:

```typescript
if (ctx.subtaskSummaries && ctx.subtaskSummaries.length > 0) {
  sections.push('## Sub-Tasks')
  sections.push('')
  for (const st of ctx.subtaskSummaries) {
    const icon = st.success ? ':white_check_mark:' : ':x:'
    sections.push(`### ${icon} ${st.title}`)
    sections.push(st.summary)
    sections.push('')
  }
}
```

- [ ] **Step 3: Run full test suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/runner/poller.ts src/publishing/pr-body.ts
git commit -m "[FEATURE] Integrate decomposer and parallel execution into poller"
```

---

### Task 10: Update Config Documentation

**Files:**
- Modify: `docs/CONFIGURATION.md`

- [ ] **Step 1: Add decomposition config docs**

Add a new section for decomposition settings:

```markdown
### Decomposition

```yaml
loop:
  decompose: false          # Enable automatic issue decomposition (default: false)
  maxSubtasks: 5            # Maximum sub-tasks per decomposition (default: 5)
  maxConcurrentSubtasks: 3  # Max parallel sub-task worktrees (default: 3)
```

When enabled, issues classified as `standard` triage level with a body exceeding 500 characters (or containing 3+ numbered items) are sent to the planner for decomposition. The planner decides whether to split the issue and outputs 2-5 atomic sub-tasks. Each sub-task runs the full Plan→Code→Verify→Review loop in its own git worktree.
```

- [ ] **Step 2: Add ACP adapter docs**

Add to the worker profiles section:

```markdown
### ACP Adapter

The `acp` adapter type uses the Agent Client Protocol via [acpx](https://github.com/openclaw/acpx) for agent-agnostic communication:

```yaml
workerProfiles:
  gemini-acp:
    type: acp
    command: gemini     # acpx agent name
    args: []
    workerTimeoutSeconds: 1800
```

Supported agents: `codex`, `claude`, `gemini`, `pi`, and any custom ACP-compatible agent.

Requires `acpx` installed as a dependency.
```

- [ ] **Step 3: Commit**

```bash
git add docs/CONFIGURATION.md
git commit -m "[DOCS] Document decomposition settings and ACP adapter configuration"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Run full verification**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: All pass with 0 errors

- [ ] **Step 2: Check test count increased**

The test count should have increased from 751 to approximately 775+ (new tests for registry, ACP adapter, decomposer parser, decomposer, parallel execution, supervisor).

- [ ] **Step 3: Verify no regressions**

```bash
git diff --stat HEAD~10  # Review all changes
```
