import type { WorkerAdapter, WorkerProfileInput } from './types.js'
import { WorkerAdapterRegistry } from './registry.js'
import { ClaudeWorkerAdapter } from './claude.js'
import { CodexWorkerAdapter } from './codex.js'
import { AcpWorkerAdapter } from './acp.js'

const defaultRegistry = new WorkerAdapterRegistry()
defaultRegistry.register('claude', () => new ClaudeWorkerAdapter())
defaultRegistry.register('codex', () => new CodexWorkerAdapter())
defaultRegistry.register('acp', () => new AcpWorkerAdapter())

export function createWorkerAdapter(profile: WorkerProfileInput): WorkerAdapter {
  return defaultRegistry.create(profile)
}

export { defaultRegistry }
