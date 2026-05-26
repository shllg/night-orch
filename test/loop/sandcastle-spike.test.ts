import { describe, it, expect, vi } from 'vitest'
import {
  runCodexSandcastleSpike,
  type SandcastleBindings,
} from '../../src/loop/sandcastle-spike.js'

describe('runCodexSandcastleSpike', () => {
  it('invokes sandcastle.run with a codex agent and head branch strategy', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({ stdout: 'done', completionSignal: 'IMPLEMENTATION_DONE' })
    const codex = vi.fn<NonNullable<SandcastleBindings['codex']>>()
      .mockReturnValue({ kind: 'codex-agent' })

    const result = await runCodexSandcastleSpike(
      {
        sandbox: { kind: 'sandbox' },
        prompt: 'Implement issue #123',
        model: 'gpt-5-codex',
        effort: 'xhigh',
      },
      { run, codex },
    )

    expect(codex).toHaveBeenCalledWith('gpt-5-codex', { effort: 'xhigh' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      sandbox: { kind: 'sandbox' },
      agent: { kind: 'codex-agent' },
      branchStrategy: { type: 'head' },
      prompt: 'Implement issue #123',
      maxIterations: 1,
      completionSignal: ['IMPLEMENTATION_DONE'],
      signal: undefined,
    })
    expect(result).toEqual({ output: 'done', completionSignal: 'IMPLEMENTATION_DONE' })
  })

  it('respects custom completion signals and max iterations', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({ stdout: 'ok', completionSignal: 'TASK_DONE' })
    const codex = vi.fn<NonNullable<SandcastleBindings['codex']>>()
      .mockReturnValue({ kind: 'codex-agent' })

    await runCodexSandcastleSpike(
      {
        sandbox: { kind: 'sandbox' },
        prompt: 'Implement issue #77',
        model: 'gpt-5-codex',
        maxIterations: 3,
        completionSignals: ['TASK_DONE'],
      },
      { run, codex },
    )

    expect(run).toHaveBeenCalledWith({
      sandbox: { kind: 'sandbox' },
      agent: { kind: 'codex-agent' },
      branchStrategy: { type: 'head' },
      prompt: 'Implement issue #77',
      maxIterations: 3,
      completionSignal: ['TASK_DONE'],
      signal: undefined,
    })
  })

  it('normalizes missing stdout to an empty string', async () => {
    const run = vi.fn<NonNullable<SandcastleBindings['run']>>()
      .mockResolvedValue({ completionSignal: 'IMPLEMENTATION_DONE' })
    const codex = vi.fn<NonNullable<SandcastleBindings['codex']>>()
      .mockReturnValue({ kind: 'codex-agent' })

    const result = await runCodexSandcastleSpike(
      {
        sandbox: { kind: 'sandbox' },
        prompt: 'Implement issue #88',
        model: 'gpt-5-codex',
      },
      { run, codex },
    )

    expect(result).toEqual({ output: '', completionSignal: 'IMPLEMENTATION_DONE' })
  })
})
