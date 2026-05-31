import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { probeHealthEndpoint, resolveSupervisorHealthTargets } from '../../src/supervisor/health.js'

describe('resolveSupervisorHealthTargets', () => {
  it('resolves web and MCP health endpoints from CLI args + config', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'night-orch-supervisor-health-'))
    try {
      const configPath = join(tempDir, 'config.yaml')
      writeFileSync(
        configPath,
        [
          'version: 1',
          'github:',
          '  tokenEnv: GITHUB_TOKEN',
          'storage:',
          '  dbPath: /tmp/state.db',
          '  worktreeRoot: /tmp/worktrees',
          '  logsRoot: /tmp/logs',
          'repos:',
          '  - repo: org/repo',
          '    localPath: /tmp/repo',
          '    labels:',
          '      ready: [no:ready]',
          'mcp:',
          '  enabled: true',
          '  httpHost: 127.0.0.1',
          '  httpPort: 4100',
        ].join('\n'),
      )

      const resolved = resolveSupervisorHealthTargets(
        tempDir,
        ['--config', configPath],
        ['--host', '0.0.0.0', '--port', '3205'],
      )

      expect(resolved.targets.webApiUrl).toBe('http://127.0.0.1:3205/api/health')
      expect(resolved.targets.webFrontendUrl).toBe('http://127.0.0.1:3205/')
      expect(resolved.targets.webHostHeader).toBeNull()
      expect(resolved.targets.runMcpUrl).toBe('http://127.0.0.1:4100/health')
      expect(resolved.warnings).toEqual([])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('returns a warning and disables MCP probe when config cannot be loaded', () => {
    const resolved = resolveSupervisorHealthTargets(
      process.cwd(),
      ['--config', '/path/does/not/exist.yaml'],
      [],
    )

    expect(resolved.targets.webApiUrl).toBe('http://127.0.0.1:3200/api/health')
    expect(resolved.targets.webHostHeader).toBeNull()
    expect(resolved.targets.runMcpUrl).toBeNull()
    expect(resolved.warnings.length).toBeGreaterThan(0)
    expect(resolved.warnings[0]).toContain('Falling back to run-process liveness checks')
  })
})

describe('probeHealthEndpoint', () => {
  let server: Server | null = null

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolveClose) => server?.close(() => resolveClose()))
      server = null
    }
  })

  it('returns ok for matching status and content-type', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ status: 'ok' }))
    })
    await new Promise<void>((resolveStart) => server?.listen(0, '127.0.0.1', () => resolveStart()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address')
    }

    const result = await probeHealthEndpoint(`http://127.0.0.1:${address.port}/health`, {
      expectedStatus: 200,
      expectedContentTypePrefix: 'application/json',
    })
    expect(result.ok).toBe(true)
  })

  it('returns details on status/content-type mismatch', async () => {
    server = createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not ready')
    })
    await new Promise<void>((resolveStart) => server?.listen(0, '127.0.0.1', () => resolveStart()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address')
    }

    const result = await probeHealthEndpoint(`http://127.0.0.1:${address.port}/health`, {
      expectedStatus: 200,
      expectedContentTypePrefix: 'application/json',
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('expected 200')
  })

  it('supports wildcard bind probes via allowed host header', async () => {
    server = createServer((req, res) => {
      const hostHeader = req.headers.host ?? ''
      if (!hostHeader.startsWith('night-orch.example.com')) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'Forbidden host' }))
        return
      }

      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html>')
    })
    await new Promise<void>((resolveStart) => server?.listen(0, '127.0.0.1', () => resolveStart()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected address')
    }

    const resolved = resolveSupervisorHealthTargets(
      process.cwd(),
      ['--config', '/path/does/not/exist.yaml'],
      [
        '--host',
        '0.0.0.0',
        '--port',
        String(address.port),
        '--allowed-host',
        'night-orch.example.com',
      ],
    )
    expect(resolved.targets.webHostHeader).toBe('night-orch.example.com')

    const withHostHeader = await probeHealthEndpoint(resolved.targets.webApiUrl, {
      expectedStatus: 200,
      expectedContentTypePrefix: 'application/json',
      hostHeader: resolved.targets.webHostHeader ?? undefined,
    })
    expect(withHostHeader.ok).toBe(true)

    const withoutHostHeader = await probeHealthEndpoint(resolved.targets.webApiUrl, {
      expectedStatus: 200,
      expectedContentTypePrefix: 'application/json',
    })
    expect(withoutHostHeader.ok).toBe(false)
    expect(withoutHostHeader.detail).toContain('expected 200')
  })
})
