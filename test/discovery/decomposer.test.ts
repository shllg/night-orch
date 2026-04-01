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

  it('sanitizes and wraps issue content in decomposition prompt', async () => {
    const adapter = makeAdapter()
    const issue = makeIssue({
      title: 'Bad <script>alert(1)</script> title',
      body: 'Read [this](https://example.com)\n\n```sh\nrm -rf /\n```',
    })

    await decomposeIssue(
      issue, adapter,
      { type: 'claude', command: 'claude', args: [], workerTimeoutSeconds: 60, minimalEnv: true, runtimeWrapper: null, env: {} },
      { PATH: '/usr/bin' }, '/tmp/wt', 5,
    )

    const runTask = adapter.runTask as ReturnType<typeof vi.fn>
    const prompt = runTask.mock.calls[0]?.[0]?.prompt as string
    expect(prompt).toContain('<untrusted_issue>')
    expect(prompt).toContain('<title>Bad alert(1) title</title>')
    expect(prompt).toContain('[link removed]')
    expect(prompt).not.toContain('https://example.com')
    expect(prompt).not.toContain('rm -rf /')
  })
})
