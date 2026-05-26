export interface SandcastleRunResult {
  stdout?: string
  completionSignal?: string
}

export interface SandcastleRunArgs {
  sandbox: unknown
  agent: unknown
  branchStrategy: { type: 'head' | 'merge-to-head' | 'branch' }
  prompt: string
  maxIterations: number
  completionSignal: string[]
  signal?: AbortSignal
}

export interface SandcastleBindings {
  run: (args: SandcastleRunArgs) => Promise<SandcastleRunResult>
  codex: (model: string, options?: { effort?: string }) => unknown
}

export interface SandcastleCodexSpikeInput {
  sandbox: unknown
  prompt: string
  model: string
  effort?: string
  maxIterations?: number
  completionSignals?: string[]
  signal?: AbortSignal
}

export interface SandcastleCodexSpikeResult {
  output: string
  completionSignal: string | undefined
}

export async function loadSandcastleBindings(): Promise<SandcastleBindings> {
  const mod = await import('@ai-hero/sandcastle')
  return {
    run: mod.run as SandcastleBindings['run'],
    codex: mod.codex as SandcastleBindings['codex'],
  }
}

export async function runCodexSandcastleSpike(
  input: SandcastleCodexSpikeInput,
  bindings: SandcastleBindings,
): Promise<SandcastleCodexSpikeResult> {
  const completionSignal = input.completionSignals ?? ['IMPLEMENTATION_DONE']
  const agent = bindings.codex(input.model, input.effort ? { effort: input.effort } : undefined)
  const result = await bindings.run({
    sandbox: input.sandbox,
    agent,
    branchStrategy: { type: 'head' },
    prompt: input.prompt,
    maxIterations: input.maxIterations ?? 1,
    completionSignal,
    signal: input.signal,
  })

  return {
    output: result.stdout ?? '',
    completionSignal: result.completionSignal,
  }
}

export async function runCodexSandcastleSpikeWithDefaults(
  input: SandcastleCodexSpikeInput,
): Promise<SandcastleCodexSpikeResult> {
  const bindings = await loadSandcastleBindings()
  return runCodexSandcastleSpike(input, bindings)
}
