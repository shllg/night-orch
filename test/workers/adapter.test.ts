import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentProvider, RunOptions, RunResult } from '@ai-hero/sandcastle'
import { SandcastleWorkerAdapter, createStrictHostSandboxProvider, type SandcastleBindings } from '../../src/workers/sandcastle.js'
import { AcpWorkerAdapter } from '../../src/workers/acp.js'
import { createSandboxProviderFactory, createWorkerAdapter } from '../../src/workers/factory.js'
import type { WorkerProfileInput, WorkerTaskInput } from '../../src/workers/types.js'

vi.mock('../../src/workers/timeout.js', () => ({
  execWithTimeout: vi.fn(),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { execWithTimeout } from '../../src/workers/timeout.js'

const mockExecWithTimeout = vi.mocked(execWithTimeout)

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
    worktreePath: '/tmp/worktree',
    prompt: 'Plan the fix',
    profile: baseProfile,
    timeoutSeconds: 1800,
    env: { PATH: '/usr/bin', HOME: '/tmp' },
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

function makeBindings(overrides: Partial<SandcastleBindings> = {}): SandcastleBindings {
  return {
    run: (async (_options: RunOptions): Promise<RunResult> => ({
      iterations: [],
      stdout: '',
      commits: [],
      branch: 'main',
    })),
    claudeCode: (() => makeAgentProvider('claude-code')) as unknown as SandcastleBindings['claudeCode'],
    codex: (() => makeAgentProvider('codex')) as unknown as SandcastleBindings['codex'],
    ...overrides,
  }
}

describe('SandcastleWorkerAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs claude tasks through sandcastle with head branch strategy', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({
        iterations: [{ sessionId: 'claude-session-1', usage: { inputTokens: 120, cacheCreationInputTokens: 30, cacheReadInputTokens: 10, outputTokens: 45 } }],
        stdout: '```json\n{"objective":"Plan the fix"}\n```',
        commits: [],
        branch: 'main',
      })
    const claudeCode = vi.fn().mockReturnValue(makeAgentProvider('claude-code'))

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'claude',
      bindings: makeBindings({ run: run as SandcastleBindings['run'], claudeCode: claudeCode as SandcastleBindings['claudeCode'] }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    const result = await adapter.runTask(makeTaskInput())

    expect(run).toHaveBeenCalledTimes(1)
    const call = run.mock.calls[0]?.[0]
    expect(call?.branchStrategy).toEqual({ type: 'head' })
    expect(call?.cwd).toBe('/tmp/worktree')
    expect(call?.prompt).toBe('Plan the fix')
    expect(call?.maxIterations).toBe(1)
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.sessionId).toBe('claude-session-1')
    expect(result.tokenUsage).toEqual({ promptTokens: 150, completionTokens: 45, cacheReadTokens: 10 })
    expect((result.parsed as { objective: string }).objective).toBe('Plan the fix')
  })

  it('extracts codex token usage from NDJSON output', async () => {
    const ndjson = [
      JSON.stringify({
        type: 'response.completed',
        usage: {
          input_tokens: 321,
          output_tokens: 123,
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '```json\\n{"objective":"Codex plan"}\\n```',
        },
      }),
      JSON.stringify({
        type: 'session',
        thread_id: 'thread-123',
      }),
    ].join('\n')

    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({
        iterations: [],
        stdout: ndjson,
        commits: [],
        branch: 'main',
      })

    const codex = vi.fn().mockReturnValue({
      ...makeAgentProvider('codex'),
      parseStreamLine: (line: string) => {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed['type'] === 'item.completed') {
          return [
            { type: 'text' as const, text: 'text chunk' },
            { type: 'result' as const, result: 'final result' },
          ]
        }
        return []
      },
    } satisfies AgentProvider)

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'codex',
      bindings: makeBindings({ run: run as SandcastleBindings['run'], codex: codex as SandcastleBindings['codex'] }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    const result = await adapter.runTask(makeTaskInput({
      profile: { ...baseProfile, type: 'codex', command: 'codex', args: ['exec', '--json'] },
    }))

    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe('thread-123')
    expect(result.tokenUsage).toEqual({ promptTokens: 321, completionTokens: 123 })
    expect((result.parsed as { objective: string }).objective).toBe('Codex plan')
  })

  it('passes worker env via sandbox provider and keeps agent env empty', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({
        iterations: [],
        stdout: '```json\n{"objective":"Plan the fix"}\n```',
        commits: [],
        branch: 'main',
      })
    const claudeCode = vi.fn().mockReturnValue(makeAgentProvider('claude-code'))
    const input = makeTaskInput({ env: { PATH: '/usr/bin', HOME: '/tmp', MISE_TRUSTED_CONFIG_PATHS: '/tmp/wt' } })

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'claude',
      bindings: makeBindings({ run: run as SandcastleBindings['run'], claudeCode: claudeCode as SandcastleBindings['claudeCode'] }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    await adapter.runTask(input)

    const call = run.mock.calls[0]?.[0]
    expect(call?.sandbox.env).toEqual(input.env)
    expect(call?.agent.env).toEqual({})
  })

  it('passes continue session id as resumeSession for claude runs', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({
        iterations: [],
        stdout: '```json\n{"objective":"Plan the fix"}\n```',
        commits: [],
        branch: 'main',
      })

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'claude',
      bindings: makeBindings({ run: run as SandcastleBindings['run'] }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    await adapter.runTask(makeTaskInput({ continueSessionId: 'claude-session-42' }))

    const call = run.mock.calls[0]?.[0]
    expect(call?.resumeSession).toBe('claude-session-42')
  })

  it('injects codex resume subcommand when continue session id is provided', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({
        iterations: [],
        stdout: '```json\n{"objective":"Plan the fix"}\n```',
        commits: [],
        branch: 'main',
      })
    const codex = vi.fn().mockReturnValue(makeAgentProvider('codex'))

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'codex',
      bindings: makeBindings({ run: run as SandcastleBindings['run'], codex: codex as SandcastleBindings['codex'] }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    await adapter.runTask(makeTaskInput({
      profile: { ...baseProfile, type: 'codex', command: 'codex', args: ['exec', '--json'] },
      continueSessionId: 'codex-thread-42',
    }))

    const call = run.mock.calls[0]?.[0]
    const command = call?.agent.buildPrintCommand({
      prompt: 'Plan the fix',
      dangerouslySkipPermissions: true,
    }).command
    expect(command).toContain('resume codex-thread-42')
  })

  it('forces codex coder runs to workspace-write sandbox and strips bypass mode', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({
        iterations: [],
        stdout: '```json\n{"summary":"implemented","changedFiles":[],"remainingUncertainty":null,"blockers":null}\n```',
        commits: [],
        branch: 'main',
      })
    const codex = vi.fn().mockReturnValue({
      ...makeAgentProvider('codex'),
      buildPrintCommand: () => ({
        command: 'codex exec --json --dangerously-bypass-approvals-and-sandbox -m gpt-5-codex',
        stdin: 'prompt',
      }),
    } satisfies AgentProvider)

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'codex',
      bindings: makeBindings({ run: run as SandcastleBindings['run'], codex: codex as SandcastleBindings['codex'] }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    await adapter.runTask(makeTaskInput({
      role: 'coder',
      profile: { ...baseProfile, type: 'codex', command: 'codex', args: ['exec', '--json'] },
    }))

    const call = run.mock.calls[0]?.[0]
    const command = call?.agent.buildPrintCommand({
      prompt: 'Plan the fix',
      dangerouslySkipPermissions: true,
    }).command ?? ''
    expect(command).toContain('--sandbox workspace-write')
    expect(command).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('forces codex reviewer runs to read-only sandbox and strips bypass mode', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({
        iterations: [],
        stdout: '```json\n{"verdict":"APPROVED","summary":"looks good","findings":[],"definitionOfDoneCheck":{"issueAddressed":true,"testsPassing":true,"noBlockingFindings":true}}\n```',
        commits: [],
        branch: 'main',
      })
    const codex = vi.fn().mockReturnValue({
      ...makeAgentProvider('codex'),
      buildPrintCommand: () => ({
        command: 'codex exec --json --dangerously-bypass-approvals-and-sandbox -m gpt-5-codex',
        stdin: 'prompt',
      }),
    } satisfies AgentProvider)

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'codex',
      bindings: makeBindings({ run: run as SandcastleBindings['run'], codex: codex as SandcastleBindings['codex'] }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    await adapter.runTask(makeTaskInput({
      role: 'reviewer',
      profile: { ...baseProfile, type: 'codex', command: 'codex', args: ['exec', '--json'] },
    }))

    const call = run.mock.calls[0]?.[0]
    const command = call?.agent.buildPrintCommand({
      prompt: 'Plan the fix',
      dangerouslySkipPermissions: true,
    }).command ?? ''
    expect(command).toContain('--sandbox read-only')
    expect(command).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('applies workspace-write via -c sandbox_mode when a codex coder resumes a session (issue #341)', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({
        iterations: [],
        stdout: '```json\n{"summary":"implemented","changedFiles":[],"remainingUncertainty":null,"blockers":null}\n```',
        commits: [],
        branch: 'main',
      })
    const codex = vi.fn().mockReturnValue({
      ...makeAgentProvider('codex'),
      buildPrintCommand: () => ({
        command: 'codex exec --json --dangerously-bypass-approvals-and-sandbox -m gpt-5-codex',
        stdin: 'prompt',
      }),
    } satisfies AgentProvider)

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'codex',
      bindings: makeBindings({ run: run as SandcastleBindings['run'], codex: codex as SandcastleBindings['codex'] }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    await adapter.runTask(makeTaskInput({
      role: 'coder',
      profile: { ...baseProfile, type: 'codex', command: 'codex', args: ['exec', '--json'] },
      continueSessionId: 'planner-session-1',
    }))

    const call = run.mock.calls[0]?.[0]
    const command = call?.agent.buildPrintCommand({
      prompt: 'Implement the fix',
      dangerouslySkipPermissions: true,
    }).command ?? ''

    // Resumes the planner's session...
    expect(command).toContain('resume planner-session-1')
    // ...and expresses workspace-write as a config override (the only form
    // `codex exec resume` honors), NOT as a --sandbox flag.
    expect(command).toContain('sandbox_mode="workspace-write"')
    expect(command).not.toContain('--sandbox')
    expect(command).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    // The config override must sit AFTER the resume subcommand to be parsed.
    expect(command.indexOf('resume')).toBeLessThan(command.indexOf('sandbox_mode'))
  })

  it('applies read-only via -c sandbox_mode when a codex reviewer resumes a session', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({
        iterations: [],
        stdout: '```json\n{"verdict":"APPROVED","summary":"ok","findings":[],"definitionOfDoneCheck":{"issueAddressed":true,"testsPassing":true,"noBlockingFindings":true}}\n```',
        commits: [],
        branch: 'main',
      })
    const codex = vi.fn().mockReturnValue({
      ...makeAgentProvider('codex'),
      buildPrintCommand: () => ({
        command: 'codex exec --json -m gpt-5-codex',
        stdin: 'prompt',
      }),
    } satisfies AgentProvider)

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'codex',
      bindings: makeBindings({ run: run as SandcastleBindings['run'], codex: codex as SandcastleBindings['codex'] }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    await adapter.runTask(makeTaskInput({
      role: 'reviewer',
      profile: { ...baseProfile, type: 'codex', command: 'codex', args: ['exec', '--json'] },
      continueSessionId: 'coder-session-2',
    }))

    const call = run.mock.calls[0]?.[0]
    const command = call?.agent.buildPrintCommand({
      prompt: 'Review the fix',
      dangerouslySkipPermissions: true,
    }).command ?? ''

    expect(command).toContain('resume coder-session-2')
    expect(command).toContain('sandbox_mode="read-only"')
    expect(command).not.toContain('--sandbox')
  })

  it('marks run as timed out when sandcastle run aborts', async () => {
    const run: SandcastleBindings['run'] = (options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        reject(options.signal?.reason ?? new Error('aborted'))
      })
    })

    const adapter = new SandcastleWorkerAdapter({
      workerType: 'codex',
      bindings: makeBindings({ run }),
      sandboxProviderFactory: createStrictHostSandboxProvider,
    })

    const result = await adapter.runTask(makeTaskInput({
      timeoutSeconds: 0.01,
      profile: { ...baseProfile, type: 'codex', command: 'codex', args: ['exec', '--json'] },
    }))

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(124)
  })

  it('checkAvailability returns available when command succeeds', async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: 'claude v1.2.3\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 100,
    })

    const adapter = new SandcastleWorkerAdapter({ workerType: 'claude', availabilityCommand: 'claude' })
    const { available, version } = await adapter.checkAvailability()

    expect(available).toBe(true)
    expect(version).toBe('claude v1.2.3')
  })

  it('checkAvailability returns unavailable on non-zero exit', async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: '',
      stderr: 'not found',
      exitCode: 127,
      timedOut: false,
      durationMs: 100,
    })

    const adapter = new SandcastleWorkerAdapter({ workerType: 'codex', availabilityCommand: 'codex' })
    const { available, version } = await adapter.checkAvailability()

    expect(available).toBe(false)
    expect(version).toBeNull()
  })
})

describe('createWorkerAdapter (factory)', () => {
  it('creates SandcastleWorkerAdapter for claude type', () => {
    const adapter = createWorkerAdapter(baseProfile)
    expect(adapter).toBeInstanceOf(SandcastleWorkerAdapter)
  })

  it('creates SandcastleWorkerAdapter for codex type', () => {
    const adapter = createWorkerAdapter({ ...baseProfile, type: 'codex' })
    expect(adapter).toBeInstanceOf(SandcastleWorkerAdapter)
  })

  it('creates AcpWorkerAdapter for acp type', () => {
    const adapter = createWorkerAdapter({ ...baseProfile, type: 'acp' })
    expect(adapter).toBeInstanceOf(AcpWorkerAdapter)
  })

  it('throws for unknown worker type', () => {
    expect(() =>
      createWorkerAdapter({ ...baseProfile, type: 'unknown' }),
    ).toThrow('No adapter registered for worker type "unknown"')
  })

  it('creates docker sandbox providers with safe env and mounts', () => {
    const factory = createSandboxProviderFactory({
      ...baseProfile,
      sandbox: {
        type: 'docker',
        image: 'night-orch-agent:latest',
        containerUid: 1000,
        containerGid: 1000,
        mounts: [{ hostPath: process.cwd(), sandboxPath: '/home/agent/.codex', readonly: true }],
        env: {
          SAFE_VALUE: 'ok',
          GITHUB_TOKEN: 'skip-me',
        },
        network: 'night-orch-test',
      },
    })

    const provider = factory({ PATH: '/usr/bin', HOME: '/home/agent' })

    expect(provider.tag).toBe('bind-mount')
    expect(provider.name).toBe('docker')
    expect(provider.env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      SAFE_VALUE: 'ok',
    })
    expect(provider.env).not.toHaveProperty('GITHUB_TOKEN')
  })

  it('creates podman sandbox providers', () => {
    const factory = createSandboxProviderFactory({
      ...baseProfile,
      sandbox: {
        type: 'podman',
        image: 'night-orch-agent:latest',
        mounts: [],
        env: {},
      },
    })

    const provider = factory({ PATH: '/usr/bin' })

    expect(provider.tag).toBe('bind-mount')
    expect(provider.name).toBe('podman')
    expect(provider.env).toMatchObject({ PATH: '/usr/bin' })
  })
})
