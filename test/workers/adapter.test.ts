import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeWorkerAdapter } from '../../src/workers/claude.js'
import { CodexWorkerAdapter } from '../../src/workers/codex.js'
import { createWorkerAdapter } from '../../src/workers/factory.js'
import type { WorkerTaskInput, WorkerProfileInput } from '../../src/workers/types.js'

// Mock timeout module
vi.mock('../../src/workers/timeout.js', () => ({
  execWithTimeout: vi.fn(),
}))
vi.mock('../../src/workers/streaming-exec.js', () => ({
  streamingExec: vi.fn(),
}))

// Suppress logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { execWithTimeout } from '../../src/workers/timeout.js'
import { streamingExec } from '../../src/workers/streaming-exec.js'

const mockExecWithTimeout = vi.mocked(execWithTimeout)
const mockStreamingExec = vi.mocked(streamingExec)

const baseProfile: WorkerProfileInput = {
  type: 'claude',
  command: 'claude',
  args: ['-p'],
  workerTimeoutSeconds: 1800,
  minimalEnv: true,
  runtimeWrapper: null,
  env: {},
}

function makeTaskInput(overrides: Partial<WorkerTaskInput> = {}): WorkerTaskInput {
  return {
    role: 'planner',
    worktreePath: '/tmp/worktree',
    prompt: 'Plan the fix',
    profile: baseProfile,
    timeoutSeconds: 1800,
    env: { PATH: '/usr/bin' },
    ...overrides,
  }
}

describe('ClaudeWorkerAdapter', () => {
  let adapter: ClaudeWorkerAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new ClaudeWorkerAdapter()
  })

  it('passes correct args to streamingExec', async () => {
    mockStreamingExec.mockResolvedValue({
      stdout: '```json\n{"objective": "Fix it"}\n```',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 5000,
    })

    await adapter.runTask(makeTaskInput())

    expect(mockStreamingExec).toHaveBeenCalledWith({
      command: 'claude',
      args: ['-p', '--output-format', 'json', '--max-turns', '50', '--permission-mode', 'bypassPermissions', '--append-system-prompt', expect.stringContaining('Do NOT use plan mode')],
      cwd: '/tmp/worktree',
      env: { PATH: '/usr/bin' },
      timeoutMs: 1_800_000,
      stdin: 'Plan the fix',
      onStdoutLine: expect.any(Function),
    })
  })

  it('parses planner output for planner role', async () => {
    mockStreamingExec.mockResolvedValue({
      stdout: '```json\n{"objective": "Fix the login"}\n```',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 5000,
    })

    const result = await adapter.runTask(makeTaskInput({ role: 'planner' }))

    expect(result.parseError).toBeNull()
    expect(result.parsed).not.toBeNull()
    expect((result.parsed as { objective: string }).objective).toBe('Fix the login')
  })

  it('parses coder output for coder role', async () => {
    mockStreamingExec.mockResolvedValue({
      stdout: '```json\n{"summary": "Fixed the bug", "changedFiles": ["a.ts"]}\n```',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 5000,
    })

    const result = await adapter.runTask(makeTaskInput({ role: 'coder' }))

    expect(result.parseError).toBeNull()
    expect(result.parsed).not.toBeNull()
    expect((result.parsed as { summary: string }).summary).toBe('Fixed the bug')
  })

  it('parses reviewer output for reviewer role', async () => {
    const reviewJson = JSON.stringify({
      verdict: 'APPROVED',
      summary: 'Looks good',
      findings: [],
      definitionOfDoneCheck: { issueAddressed: true, testsPassing: true, noBlockingFindings: true },
    })
    mockStreamingExec.mockResolvedValue({
      stdout: `\`\`\`json\n${reviewJson}\n\`\`\``,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 5000,
    })

    const result = await adapter.runTask(makeTaskInput({ role: 'reviewer' }))

    expect(result.parseError).toBeNull()
    expect((result.parsed as { verdict: string }).verdict).toBe('APPROVED')
  })

  it('reports timeout', async () => {
    mockStreamingExec.mockResolvedValue({
      stdout: '',
      stderr: 'killed',
      exitCode: 143,
      timedOut: true,
      durationMs: 1_800_000,
    })

    const result = await adapter.runTask(makeTaskInput())

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(143)
  })

  it('falls back to text plan when output has no JSON block', async () => {
    mockStreamingExec.mockResolvedValue({
      stdout: 'This is not JSON at all',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 1000,
    })

    const result = await adapter.runTask(makeTaskInput())

    expect(result.parsed).not.toBeNull()
    expect((result.parsed as { objective: string }).objective).toBe('This is not JSON at all')
    expect(result.parseError).toContain('fallback')
  })

  it('returns raw output regardless of parse success', async () => {
    const rawOutput = 'Raw worker output here'
    mockStreamingExec.mockResolvedValue({
      stdout: rawOutput,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 1000,
    })

    const result = await adapter.runTask(makeTaskInput())

    expect(result.rawOutput).toBe(rawOutput)
  })

  it('checkAvailability returns available when command succeeds', async () => {
    mockExecWithTimeout.mockResolvedValue({
      stdout: 'claude v1.2.3\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 100,
    })

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

    const { available, version } = await adapter.checkAvailability()

    expect(available).toBe(false)
    expect(version).toBeNull()
  })
})

describe('CodexWorkerAdapter', () => {
  let adapter: CodexWorkerAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new CodexWorkerAdapter()
  })

  it('passes prompt via stdin (no --output-format)', async () => {
    mockStreamingExec.mockResolvedValue({
      stdout: '```json\n{"objective": "Fix it"}\n```',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 5000,
    })

    const codexProfile = { ...baseProfile, type: 'codex' as const, command: 'codex' }
    await adapter.runTask(makeTaskInput({ profile: codexProfile }))

    expect(mockStreamingExec).toHaveBeenCalledWith(expect.objectContaining({
      command: 'codex',
      args: expect.arrayContaining(['-p', '--output-last-message']),
      cwd: '/tmp/worktree',
      env: { PATH: '/usr/bin' },
      timeoutMs: 1_800_000,
      stdin: 'Plan the fix',
      onStdoutLine: expect.any(Function),
    }))
  })

  it('applies runtime wrapper when configured', async () => {
    mockStreamingExec.mockResolvedValue({
      stdout: '```json\n{"objective":"wrapped"}\n```',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 1000,
    })

    const wrappedProfile = {
      ...baseProfile,
      type: 'codex' as const,
      command: 'codex',
      runtimeWrapper: 'firejail --quiet',
    }
    await adapter.runTask(makeTaskInput({ profile: wrappedProfile }))

    expect(mockStreamingExec).toHaveBeenCalledWith(expect.objectContaining({
      command: 'firejail',
      args: expect.arrayContaining(['--quiet', 'codex', '-p', '--output-last-message']),
      stdin: 'Plan the fix',
      onStdoutLine: expect.any(Function),
    }))
  })

  it('parses output the same way as Claude adapter', async () => {
    mockStreamingExec.mockResolvedValue({
      stdout: '```json\n{"objective": "Codex plan"}\n```',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 5000,
    })

    const result = await adapter.runTask(makeTaskInput({ role: 'planner' }))

    expect(result.parseError).toBeNull()
    expect((result.parsed as { objective: string }).objective).toBe('Codex plan')
  })
})

describe('createWorkerAdapter (factory)', () => {
  it('creates ClaudeWorkerAdapter for claude type', () => {
    const adapter = createWorkerAdapter(baseProfile)
    expect(adapter).toBeInstanceOf(ClaudeWorkerAdapter)
  })

  it('creates CodexWorkerAdapter for codex type', () => {
    const adapter = createWorkerAdapter({ ...baseProfile, type: 'codex' })
    expect(adapter).toBeInstanceOf(CodexWorkerAdapter)
  })

  it('throws for unknown worker type', () => {
    expect(() =>
      createWorkerAdapter({ ...baseProfile, type: 'unknown' }),
    ).toThrow('No adapter registered for worker type "unknown"')
  })
})
