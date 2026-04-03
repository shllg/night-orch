import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { rollbackToCheckpoint, runUpdate } from '../../src/supervisor/updater.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockExeca = vi.mocked(execa)

function createStatusTrackerMock() {
  return {
    transition: vi.fn(),
  }
}

describe('runUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns success when pull + build complete', async () => {
    const status = createStatusTrackerMock()
    mockExeca
      .mockResolvedValueOnce({ stdout: 'old-commit\n', stderr: '', exitCode: 0 } as never) // git rev-parse HEAD
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '', exitCode: 0 } as never) // git branch --show-current
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // git pull
      .mockResolvedValueOnce({ stdout: 'new-commit\n', stderr: '', exitCode: 0 } as never) // git rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // pnpm install
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // pnpm build
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // pnpm install-global

    const result = await runUpdate('/repo', status as never)

    expect(result.success).toBe(true)
    expect(result.previousCommit).toBe('old-commit')
    expect(result.previousRef).toBe('main')
    expect(result.newCommit).toBe('new-commit')
    expect(status.transition).toHaveBeenCalledWith(
      'pulling',
      expect.objectContaining({ previousCommit: 'old-commit' }),
    )
    expect(status.transition).toHaveBeenCalledWith('building', { targetCommit: 'new-commit' })
  })

  it('rolls back when build fails', async () => {
    const status = createStatusTrackerMock()
    mockExeca
      .mockResolvedValueOnce({ stdout: 'old-commit\n', stderr: '', exitCode: 0 } as never) // git rev-parse HEAD
      .mockResolvedValueOnce({ stdout: 'main\n', stderr: '', exitCode: 0 } as never) // git branch --show-current
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // git pull
      .mockResolvedValueOnce({ stdout: 'new-commit\n', stderr: '', exitCode: 0 } as never) // git rev-parse HEAD
      .mockRejectedValueOnce(new Error('pnpm build failed')) // pnpm install (build pipeline failure)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // git checkout -B main old-commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // pnpm install
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // pnpm build
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // pnpm install-global

    const result = await runUpdate('/repo', status as never)

    expect(result.success).toBe(false)
    expect(result.previousCommit).toBe('old-commit')
    expect(result.newCommit).toBe('old-commit')
    expect(result.error).toContain('Build failed')
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['checkout', '-B', 'main', 'old-commit'],
      expect.objectContaining({ cwd: '/repo' }),
    )
    expect(status.transition).toHaveBeenCalledWith('failed', expect.objectContaining({ error: expect.any(String) }))
  })
})

describe('rollbackToCheckpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('checks out commit directly when previous ref is unknown', async () => {
    const status = createStatusTrackerMock()
    mockExeca
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // git checkout commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // pnpm install
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // pnpm build
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // pnpm install-global

    const result = await rollbackToCheckpoint(
      '/repo',
      status as never,
      { previousCommit: 'abc123', previousRef: null },
      'health checks failed',
    )

    expect(result.success).toBe(true)
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['checkout', 'abc123'],
      expect.objectContaining({ cwd: '/repo' }),
    )
  })
})
