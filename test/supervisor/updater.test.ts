import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { rollbackToCheckpoint, runUpdate } from '../../src/supervisor/updater.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

vi.mock('node:fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  }
})

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockExeca = vi.mocked(execa)
const mockExistsSync = vi.mocked(existsSync)

function createStatusTrackerMock() {
  return {
    transition: vi.fn(),
  }
}

describe('runUpdate (git mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Simulate git checkout: .git directory exists
    mockExistsSync.mockReturnValue(true)
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

describe('runUpdate (npm mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Simulate npm install: no .git directory
    mockExistsSync.mockReturnValue(false)
  })

  it('returns success when newer version is available', async () => {
    const { readFileSync } = await import('node:fs')
    const mockReadFileSync = vi.mocked(readFileSync)
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ version: '0.2.0' }))

    const status = createStatusTrackerMock()
    mockExeca
      .mockResolvedValueOnce({ stdout: '0.3.0\n', stderr: '', exitCode: 0 } as never) // npm view
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // npm install -g

    const result = await runUpdate('/pkg', status as never)

    expect(result.success).toBe(true)
    expect(result.previousCommit).toBe('0.2.0')
    expect(result.newCommit).toBe('0.3.0')
    expect(mockExeca).toHaveBeenCalledWith('npm', ['install', '-g', 'night-orch@0.3.0'])
  })

  it('returns success immediately when already at latest', async () => {
    const { readFileSync } = await import('node:fs')
    const mockReadFileSync = vi.mocked(readFileSync)
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ version: '0.2.0' }))

    const status = createStatusTrackerMock()
    mockExeca
      .mockResolvedValueOnce({ stdout: '0.2.0\n', stderr: '', exitCode: 0 } as never) // npm view

    const result = await runUpdate('/pkg', status as never)

    expect(result.success).toBe(true)
    expect(result.previousCommit).toBe('0.2.0')
    expect(result.newCommit).toBe('0.2.0')
    expect(status.transition).toHaveBeenCalledWith('idle', expect.objectContaining({ completedAt: expect.any(String) }))
  })
})

describe('rollbackToCheckpoint (git mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
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

describe('rollbackToCheckpoint (npm mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
  })

  it('runs npm install -g with previous version', async () => {
    const status = createStatusTrackerMock()
    mockExeca
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as never) // npm install -g

    const result = await rollbackToCheckpoint(
      '/pkg',
      status as never,
      { previousCommit: '0.2.0', previousRef: null },
      'health checks failed',
    )

    expect(result.success).toBe(true)
    expect(mockExeca).toHaveBeenCalledWith('npm', ['install', '-g', 'night-orch@0.2.0'])
  })
})
