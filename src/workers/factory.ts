import type { WorkerAdapter, WorkerProfileInput } from './types.js'
import { WorkerAdapterRegistry } from './registry.js'
import { AcpWorkerAdapter } from './acp.js'
import { SandcastleWorkerAdapter } from './sandcastle.js'

const defaultRegistry = new WorkerAdapterRegistry()
defaultRegistry.register('claude', (profile) => new SandcastleWorkerAdapter({
  workerType: 'claude',
  availabilityCommand: profile.command,
}))
defaultRegistry.register('codex', (profile) => new SandcastleWorkerAdapter({
  workerType: 'codex',
  availabilityCommand: profile.command,
}))
defaultRegistry.register('acp', () => new AcpWorkerAdapter())

export function createWorkerAdapter(profile: WorkerProfileInput): WorkerAdapter {
  return defaultRegistry.create(profile)
}

export { defaultRegistry }
