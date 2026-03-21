export class ForgejoApiError extends Error {
  readonly status: number
  readonly statusText: string

  constructor(status: number, statusText: string, message: string) {
    super(`Forgejo API error ${status} (${statusText}): ${message}`)
    this.name = 'ForgejoApiError'
    this.status = status
    this.statusText = statusText
  }
}

function parseLinkHeader(header: string | null): string | null {
  if (!header) return null
  const match = header.match(/<([^>]+)>;\s*rel="next"/)
  return match?.[1] ?? null
}

export class ForgejoClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, token: string, timeoutMs = 30_000) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.timeoutMs = timeoutMs
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = this.buildUrl(path, params)
    const res = await fetch(url, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    await this.assertOk(res)
    return (await res.json()) as T
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path)
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    await this.assertOk(res)
    return (await res.json()) as T
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path)
    const res = await fetch(url, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    await this.assertOk(res)
    return (await res.json()) as T
  }

  async delete(path: string): Promise<void> {
    const url = this.buildUrl(path)
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    await this.assertOk(res)
  }

  async getPaginated<T>(path: string, params?: Record<string, string>): Promise<T[]> {
    const allItems: T[] = []
    let url: string | null = this.buildUrl(path, { ...params, limit: params?.limit ?? '50' })

    while (url) {
      const res = await fetch(url, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      await this.assertOk(res)
      const items = (await res.json()) as T[]
      allItems.push(...items)
      url = parseLinkHeader(res.headers.get('link'))
    }

    return allItems
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${path}`)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
    }
    return url.toString()
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return
    let message: string
    try {
      const body = (await res.json()) as { message?: string }
      message = body.message ?? res.statusText
    } catch {
      message = res.statusText
    }
    throw new ForgejoApiError(res.status, res.statusText, message)
  }
}
