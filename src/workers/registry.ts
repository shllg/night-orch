import type { WorkerAdapter, WorkerProfileInput } from './types.js'

export type WorkerAdapterFactory = (profile: WorkerProfileInput) => WorkerAdapter

export class WorkerAdapterRegistry {
  private factories = new Map<string, WorkerAdapterFactory>()

  register(type: string, factory: WorkerAdapterFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`Worker adapter type "${type}" is already registered`)
    }
    this.factories.set(type, factory)
  }

  create(profile: WorkerProfileInput): WorkerAdapter {
    const factory = this.factories.get(profile.type)
    if (!factory) {
      const known = [...this.factories.keys()].join(', ')
      throw new Error(
        `No adapter registered for worker type "${profile.type}". Registered types: ${known}`,
      )
    }
    return factory(profile)
  }

  getRegisteredTypes(): string[] {
    return [...this.factories.keys()]
  }
}
