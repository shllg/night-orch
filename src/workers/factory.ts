import type { WorkerAdapter, WorkerProfileInput } from './types.js'
import type { SandboxProvider } from '@ai-hero/sandcastle'
import { docker } from '@ai-hero/sandcastle/sandboxes/docker'
import { podman } from '@ai-hero/sandcastle/sandboxes/podman'
import { AcpWorkerAdapter } from './acp.js'
import { SandcastleWorkerAdapter, createStrictHostSandboxProvider } from './sandcastle.js'
import { filterSafeEnv } from './env.js'

export function createWorkerAdapter(profile: WorkerProfileInput): WorkerAdapter {
  switch (profile.type) {
    case 'claude':
      return new SandcastleWorkerAdapter({
        workerType: 'claude',
        availabilityCommand: profile.command,
        sandboxProviderFactory: createSandboxProviderFactory(profile),
      })
    case 'codex':
      return new SandcastleWorkerAdapter({
        workerType: 'codex',
        availabilityCommand: profile.command,
        sandboxProviderFactory: createSandboxProviderFactory(profile),
      })
    case 'acp':
      return new AcpWorkerAdapter()
    default:
      throw new Error(`No adapter registered for worker type "${profile.type}". Registered types: claude, codex, acp`)
  }
}

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
