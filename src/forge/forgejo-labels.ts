import type { ForgejoClient } from './forgejo-client.js'

interface ForgejoLabel {
  id: number
  name: string
}

export class LabelCache {
  private readonly client: ForgejoClient
  private readonly cache = new Map<string, Map<string, number>>()
  private readonly pending = new Map<string, Promise<Map<string, number>>>()

  constructor(client: ForgejoClient) {
    this.client = client
  }

  async getIdByName(repo: string, labelName: string): Promise<number | null> {
    const map = await this.ensureLoaded(repo)
    return map.get(labelName) ?? null
  }

  async getIdsByNames(repo: string, labelNames: string[]): Promise<Array<number | null>> {
    const map = await this.ensureLoaded(repo)
    return labelNames.map((name) => map.get(name) ?? null)
  }

  invalidate(repo: string): void {
    this.cache.delete(repo)
    this.pending.delete(repo)
  }

  private async ensureLoaded(repo: string): Promise<Map<string, number>> {
    const cached = this.cache.get(repo)
    if (cached) return cached

    // Deduplicate concurrent fetches for the same repo
    const inflight = this.pending.get(repo)
    if (inflight) return inflight

    const promise = this.fetchLabels(repo)
    this.pending.set(repo, promise)

    try {
      const map = await promise
      this.cache.set(repo, map)
      return map
    } finally {
      this.pending.delete(repo)
    }
  }

  private async fetchLabels(repo: string): Promise<Map<string, number>> {
    const [owner, name] = repo.split('/')
    if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`)

    const labels = await this.client.getPaginated<ForgejoLabel>(
      `/repos/${owner}/${name}/labels`,
    )

    const map = new Map<string, number>()
    for (const label of labels) {
      map.set(label.name, label.id)
    }
    return map
  }
}
