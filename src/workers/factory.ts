import type { WorkerAdapter, WorkerProfileInput } from './types.js'
import type { SandboxProvider } from '@ai-hero/sandcastle'
import { docker } from '@ai-hero/sandcastle/sandboxes/docker'
import { podman } from '@ai-hero/sandcastle/sandboxes/podman'
import { WorkerAdapterRegistry } from './registry.js'
import { AcpWorkerAdapter } from './acp.js'
import { SandcastleWorkerAdapter, createStrictHostSandboxProvider } from './sandcastle.js'
import { filterSafeEnv } from './env.js'

const defaultRegistry = new WorkerAdapterRegistry()
defaultRegistry.register('claude', (profile) => new SandcastleWorkerAdapter({
  workerType: 'claude',
  availabilityCommand: profile.command,
  sandboxProviderFactory: createSandboxProviderFactory(profile),
}))
defaultRegistry.register('codex', (profile) => new SandcastleWorkerAdapter({
  workerType: 'codex',
  availabilityCommand: profile.command,
  sandboxProviderFactory: createSandboxProviderFactory(profile),
}))
defaultRegistry.register('acp', () => new AcpWorkerAdapter())

export function createWorkerAdapter(profile: WorkerProfileInput): WorkerAdapter {
  return defaultRegistry.create(profile)
}

export { defaultRegistry }

export function createSandboxProviderFactory(
  profile: WorkerProfileInput,
): (sandboxEnv: Record<string, string>) => SandboxProvider {
  const sandbox = profile.sandbox ?? { type: 'host' as const, mounts: [], env: {} }
  if (sandbox.type === 'host') return createStrictHostSandboxProvider

  return (sandboxEnv) => {
    const env = {
      ...sandboxEnv,
      ...filterSafeEnv(sandbox.env, 'Worker sandbox env contains blacklisted variable — skipped'),
    }
    const options = {
      ...(sandbox.image ? { imageName: sandbox.image } : {}),
      ...(sandbox.containerUid !== undefined ? { containerUid: sandbox.containerUid } : {}),
      ...(sandbox.containerGid !== undefined ? { containerGid: sandbox.containerGid } : {}),
      ...(sandbox.mounts.length > 0 ? { mounts: sandbox.mounts } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(sandbox.network !== undefined ? { network: sandbox.network } : {}),
    }

    return sandbox.type === 'docker'
      ? docker(options)
      : podman(options)
  }
}
