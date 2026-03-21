import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ForgejoClient, ForgejoApiError } from '../../src/forge/forgejo-client.js'

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

describe('ForgejoClient', () => {
  let client: ForgejoClient

  beforeEach(() => {
    mockFetch.mockReset()
    client = new ForgejoClient('https://forgejo.example.com/api/v1', 'test-token')
  })

  describe('auth header', () => {
    it('uses token format (not Bearer)', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1 }))

      await client.get('/user')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token test-token',
          }),
        }),
      )
    })
  })

  describe('get', () => {
    it('makes GET request with params', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ id: 1 }]))

      const result = await client.get('/repos/org/repo/issues', { state: 'open' })

      expect(result).toEqual([{ id: 1 }])
      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/issues')
      expect(calledUrl).toContain('state=open')
    })

    it('makes GET request without params', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ login: 'bot' }))

      const result = await client.get('/user')

      expect(result).toEqual({ login: 'bot' })
    })
  })

  describe('post', () => {
    it('makes POST request with JSON body', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1 }))

      await client.post('/repos/org/repo/issues/1/comments', { body: 'hello' })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/org/repo/issues/1/comments'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ body: 'hello' }),
        }),
      )
    })
  })

  describe('patch', () => {
    it('makes PATCH request with JSON body', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1, title: 'Updated' }))

      const result = await client.patch('/repos/org/repo/pulls/1', { title: 'Updated' })

      expect(result).toEqual({ id: 1, title: 'Updated' })
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
  })

  describe('delete', () => {
    it('makes DELETE request', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        statusText: 'No Content',
        headers: new Headers(),
        json: () => Promise.resolve(undefined),
      } as unknown as Response)

      await client.delete('/repos/org/repo/issues/1/labels/5')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/org/repo/issues/1/labels/5'),
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  describe('getPaginated', () => {
    it('follows Link headers until all pages fetched', async () => {
      const page1Url = 'https://forgejo.example.com/api/v1/repos/org/repo/labels?limit=50'
      const page2Url = 'https://forgejo.example.com/api/v1/repos/org/repo/labels?page=2&limit=50'

      mockFetch
        .mockResolvedValueOnce(
          jsonResponse(
            [{ id: 1, name: 'bug' }],
            200,
            { link: `<${page2Url}>; rel="next"` },
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse([{ id: 2, name: 'feature' }]),
        )

      const result = await client.getPaginated<{ id: number; name: string }>('/repos/org/repo/labels')

      expect(result).toEqual([
        { id: 1, name: 'bug' },
        { id: 2, name: 'feature' },
      ])
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('returns single page when no Link header', async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ id: 1 }]))

      const result = await client.getPaginated('/repos/org/repo/labels')

      expect(result).toEqual([{ id: 1 }])
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('error handling', () => {
    it('throws ForgejoApiError on 401', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401))

      await expect(client.get('/user')).rejects.toThrow(ForgejoApiError)
      await expect(client.get('/user')).rejects.toThrow(/401/)
    })

    it('throws ForgejoApiError on 404', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404))

      await expect(client.get('/repos/org/missing')).rejects.toThrow(ForgejoApiError)
    })

    it('throws ForgejoApiError on 500', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ message: 'Internal Server Error' }, 500))

      await expect(client.get('/user')).rejects.toThrow(ForgejoApiError)
      await expect(client.get('/user')).rejects.toThrow(/500/)
    })

    it('includes error message from response body', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ message: 'token is invalid' }, 401))

      try {
        await client.get('/user')
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ForgejoApiError)
        expect((err as ForgejoApiError).message).toContain('token is invalid')
        expect((err as ForgejoApiError).status).toBe(401)
      }
    })

    it('handles non-JSON error responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        headers: new Headers(),
        json: () => Promise.reject(new Error('not json')),
      } as unknown as Response)

      await expect(client.get('/user')).rejects.toThrow(ForgejoApiError)
    })
  })

  describe('URL construction', () => {
    it('strips trailing slashes from base URL', async () => {
      const c = new ForgejoClient('https://forgejo.example.com/api/v1/', 'tok')
      mockFetch.mockResolvedValue(jsonResponse({ login: 'bot' }))

      await c.get('/user')

      const calledUrl = mockFetch.mock.calls[0]![0] as string
      // Verify no double slashes except in https://
      expect(calledUrl.replace('https://', '')).not.toContain('//')
      expect(calledUrl).toContain('api/v1/user')
    })
  })
})
