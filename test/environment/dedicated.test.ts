import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startDedicatedStack, stopDedicatedStack } from '../../src/environment/dedicated.js'

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}))

// Suppress logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { execa } from 'execa'

const mockExeca = vi.mocked(execa)

describe('startDedicatedStack', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs docker compose up with correct args', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    await startDedicatedStack({
      worktreePath: '/tmp/wt',
      composeFile: 'docker-compose.yml',
      services: ['db', 'redis'],
      projectName: 'orch-42',
    })

    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['compose', '-p', 'orch-42', '-f', 'docker-compose.yml', 'up', '-d', 'db', 'redis'],
      expect.objectContaining({ cwd: '/tmp/wt', timeout: 120_000, extendEnv: false }),
    )
  })

  it('runs with no services (starts all)', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    await startDedicatedStack({
      worktreePath: '/tmp/wt',
      composeFile: 'compose.yaml',
      services: [],
      projectName: 'orch-1',
    })

    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['compose', '-p', 'orch-1', '-f', 'compose.yaml', 'up', '-d'],
      expect.objectContaining({ cwd: '/tmp/wt', timeout: 120_000, extendEnv: false }),
    )
  })

  it('runs healthcheck after compose up', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0 } as never) // compose up
      .mockResolvedValueOnce({ exitCode: 0 } as never) // healthcheck

    await startDedicatedStack({
      worktreePath: '/tmp/wt',
      composeFile: 'compose.yaml',
      services: [],
      projectName: 'orch-1',
      healthcheck: 'curl http://localhost:5103/health',
    })

    expect(mockExeca).toHaveBeenCalledTimes(2)
    expect(mockExeca).toHaveBeenLastCalledWith(
      'curl',
      ['http://localhost:5103/health'],
      expect.objectContaining({ timeout: 5_000, extendEnv: false }),
    )
  })

  it('retries healthcheck on failure', async () => {
    // Patch setTimeout to be instant for this test
    const origSetTimeout = globalThis.setTimeout
    vi.stubGlobal('setTimeout', (fn: () => void) => origSetTimeout(fn, 0))

    mockExeca
      .mockResolvedValueOnce({ exitCode: 0 } as never) // compose up
      .mockRejectedValueOnce(new Error('not ready')) // healthcheck attempt 1
      .mockResolvedValueOnce({ exitCode: 0 } as never) // healthcheck attempt 2

    await startDedicatedStack({
      worktreePath: '/tmp/wt',
      composeFile: 'compose.yaml',
      services: [],
      projectName: 'orch-1',
      healthcheck: 'pg_isready',
    })

    vi.unstubAllGlobals()

    // compose up + 2 healthcheck attempts
    expect(mockExeca).toHaveBeenCalledTimes(3)
  })

  it('throws after all healthcheck retries exhausted', async () => {
    // Patch setTimeout to be instant for this test
    const origSetTimeout = globalThis.setTimeout
    vi.stubGlobal('setTimeout', (fn: () => void) => origSetTimeout(fn, 0))

    mockExeca
      .mockResolvedValueOnce({ exitCode: 0 } as never) // compose up
    // All healthcheck attempts fail
    for (let i = 0; i < 10; i++) {
      mockExeca.mockRejectedValueOnce(new Error('not ready'))
    }

    await expect(
      startDedicatedStack({
        worktreePath: '/tmp/wt',
        composeFile: 'compose.yaml',
        services: [],
        projectName: 'orch-1',
        healthcheck: 'pg_isready',
      }),
    ).rejects.toThrow(/Dedicated stack healthcheck failed after retries/)

    vi.unstubAllGlobals()
  })

  it('skips healthcheck when not configured', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    await startDedicatedStack({
      worktreePath: '/tmp/wt',
      composeFile: 'compose.yaml',
      services: [],
      projectName: 'orch-1',
    })

    // Only compose up, no healthcheck
    expect(mockExeca).toHaveBeenCalledTimes(1)
  })

  it('supports array-form healthcheck commands', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0 } as never)
      .mockResolvedValueOnce({ exitCode: 0 } as never)

    await startDedicatedStack({
      worktreePath: '/tmp/wt',
      composeFile: 'compose.yaml',
      services: [],
      projectName: 'orch-1',
      healthcheck: ['curl', 'http://localhost:5103/health'],
    })

    expect(mockExeca).toHaveBeenLastCalledWith(
      'curl',
      ['http://localhost:5103/health'],
      expect.objectContaining({ timeout: 5_000, extendEnv: false }),
    )
  })
})

describe('stopDedicatedStack', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs docker compose down with volumes', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    await stopDedicatedStack('/tmp/wt', 'compose.yaml', 'orch-42')

    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['compose', '-p', 'orch-42', '-f', 'compose.yaml', 'down', '-v'],
      expect.objectContaining({ cwd: '/tmp/wt', timeout: 60_000, extendEnv: false }),
    )
  })

  it('does not throw if compose down fails', async () => {
    mockExeca.mockRejectedValue(new Error('stack not found'))

    await expect(stopDedicatedStack('/tmp/wt', 'compose.yaml', 'orch-42')).resolves.toBeUndefined()
  })
})
