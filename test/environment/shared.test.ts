import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateSharedEnvironment } from '../../src/environment/shared.js'

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

describe('validateSharedEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips validation when no healthcheck configured', async () => {
    await expect(validateSharedEnvironment(undefined)).resolves.toBeUndefined()
    expect(mockExeca).not.toHaveBeenCalled()
  })

  it('passes when healthcheck command succeeds', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    await expect(validateSharedEnvironment('curl http://localhost:3000/health')).resolves.toBeUndefined()

    expect(mockExeca).toHaveBeenCalledWith(
      'curl',
      ['http://localhost:3000/health'],
      { timeout: 10_000 },
    )
  })

  it('throws when healthcheck fails and requireRunning is true', async () => {
    mockExeca.mockRejectedValue(new Error('Connection refused'))

    await expect(
      validateSharedEnvironment('curl http://localhost:3000/health', true),
    ).rejects.toThrow(/Shared environment healthcheck failed/)
  })

  it('warns but does not throw when healthcheck fails and requireRunning is false', async () => {
    mockExeca.mockRejectedValue(new Error('Connection refused'))

    await expect(
      validateSharedEnvironment('curl http://localhost:3000/health', false),
    ).resolves.toBeUndefined()
  })

  it('splits healthcheck command into binary and args', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never)

    await validateSharedEnvironment('docker compose ps --services')

    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['compose', 'ps', '--services'],
      { timeout: 10_000 },
    )
  })

  it('defaults requireRunning to true', async () => {
    mockExeca.mockRejectedValue(new Error('fail'))

    await expect(validateSharedEnvironment('check-it')).rejects.toThrow()
  })
})
