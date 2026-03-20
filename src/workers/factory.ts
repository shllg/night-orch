import type { WorkerAdapter, WorkerProfileInput } from './types.js'
import { ClaudeWorkerAdapter } from './claude.js'
import { CodexWorkerAdapter } from './codex.js'

export function createWorkerAdapter(profile: WorkerProfileInput): WorkerAdapter {
  switch (profile.type) {
    case 'claude':
      return new ClaudeWorkerAdapter()
    case 'codex':
      return new CodexWorkerAdapter()
    default:
      throw new Error(`Unknown worker type: ${profile.type as string}`)
  }
}
