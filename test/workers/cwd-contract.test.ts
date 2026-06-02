import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentProvider, RunOptions, RunResult } from '@ai-hero/sandcastle'
import { SandcastleWorkerAdapter, type SandcastleBindings } from '../../src/workers/sandcastle.js'
import { AcpWorkerAdapter } from '../../src/workers/acp.js'
import type { WorkerProfileInput, WorkerTaskInput } from '../../src/workers/types.js'

const mockRunOnce = vi.fn()
const mockSendSessionDirect = vi.fn()

vi.mock('../../src/workers/acpx-imports.js', () => ({
  loadAcpxRuntime: vi.fn().mockResolvedValue({
    runOnce: (...args: unknown[]) => mockRunOnce(...args),
    sendSessionDirect: (...args: unknown[]) => mockSendSessionDirect(...args),
  }),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const worktreePath = '/tmp/night-orch-worktree'

const baseProfile: WorkerProfileInput = {
  type: 'claude',
  command: 'claude',
  args: ['-p'],
  workerTimeoutSeconds: 1800,
  minimalEnv: true,
  runtimeWrapper: null,
  env: {},
  sandbox: { type: 'host', mounts: [], env: {} },
}

function makeTaskInput(overrides: Partial<WorkerTaskInput> = {}): WorkerTaskInput {
  return {
    role: 'planner',
    worktreePath,
    prompt: 'Plan the fix',
    profile: baseProfile,
    timeoutSeconds: 1800,
    env: { PATH: '/usr/bin' },
    ...overrides,
  }
}

function makeAgentProvider(name: string): AgentProvider {
  return {
    name,
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({ command: `${name} exec`, stdin: 'prompt' }),
    parseStreamLine: () => [],
  }
}

function makeBindings(run: SandcastleBindings['run']): SandcastleBindings {
  return {
    run,
    claudeCode: (() => makeAgentProvider('claude-code')) as unknown as SandcastleBindings['claudeCode'],
    codex: (() => makeAgentProvider('codex')) as unknown as SandcastleBindings['codex'],
  }
}

describe('worker cwd contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs Sandcastle workers inside the worktree', async () => {
    const sandcastleRun = vi.fn<(options: RunOptions) => Promise<RunResult>>()
      .mockResolvedValue({
        iterations: [],
        stdout: '```json\n{"objective":"Plan the fix"}\n```',
        commits: [],
        branch: 'main',
      })
    const adapter = new SandcastleWorkerAdapter({
      workerType: 'claude',
      bindings: makeBindings(sandcastleRun),
    })

    await adapter.runTask(makeTaskInput())

    expect(sandcastleRun).toHaveBeenCalledWith(expect.objectContaining({
      cwd: worktreePath,
    }))
  })

  it('runs fresh ACP workers inside the worktree', async () => {
    mockRunOnce.mockResolvedValue({ sessionId: 'acp-session' })
    const adapter = new AcpWorkerAdapter()

    await adapter.runTask(makeTaskInput({
      profile: { ...baseProfile, type: 'acp', command: 'codex', args: [] },
    }))

    expect(mockRunOnce).toHaveBeenCalledWith(expect.objectContaining({
      cwd: worktreePath,
    }))
  })

  it('runs ACP resume fallback workers inside the worktree', async () => {
    mockSendSessionDirect.mockRejectedValue(new Error('session not found'))
    mockRunOnce.mockResolvedValue({ sessionId: 'acp-session-new' })
    const adapter = new AcpWorkerAdapter()

    await adapter.runTask(makeTaskInput({
      profile: { ...baseProfile, type: 'acp', command: 'codex', args: [] },
      continueSessionId: 'acp-session-old',
    }))

    expect(mockRunOnce).toHaveBeenCalledWith(expect.objectContaining({
      cwd: worktreePath,
    }))
  })
})
