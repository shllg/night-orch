import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/loop/verifier.js', () => ({
  runVerifyCommands: vi.fn(),
  stripVerifyHooks: (spec: unknown) => spec,
}))

import { runVerifyCommands } from '../../src/loop/verifier.js'
import { runPreflightDriftCheck } from '../../src/loop/preflight.js'
import type { Config, RepoConfig } from '../../src/config/schema.js'
import type { WorktreeManager } from '../../src/git/worktree.js'
import type { VerifyResult } from '../../src/workers/types.js'

const mockRunVerify = vi.mocked(runVerifyCommands)

function repo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: 'org/repo',
    forge: 'github',
    localPath: '/repo',
    baseBranch: 'main',
    branchPrefix: 'orch',
    updateStrategy: 'merge',
    verify: ['pnpm test'],
    verificationProfile: undefined,
    preflight: { enabled: true, commands: ['pnpm test'] },
    ...overrides,
  } as unknown as RepoConfig
}

const config = { verificationProfiles: {} } as unknown as Config

function fakeWorktreeManager(): WorktreeManager & {
  ensure: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  return {
    ensure: vi.fn().mockResolvedValue({
      path: '/wt/org__repo/__preflight',
      branchName: 'orch-preflight',
      exists: true,
      isClean: true,
      rebaseConflict: false,
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  } as never
}

function verifyResult(passed: boolean): VerifyResult {
  return {
    command: 'pnpm test',
    exitCode: passed ? 0 : 1,
    stdout: '',
    stderr: passed ? '' : 'FAIL src/foo.test.ts',
    durationMs: 10,
    passed,
  }
}

describe('runPreflightDriftCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('short-circuits to ok when disabled (no worktree, no verify)', async () => {
    const wm = fakeWorktreeManager()
    const result = await runPreflightDriftCheck({
      config,
      repoConfig: repo({ preflight: { enabled: false } as RepoConfig['preflight'] }),
      worktreeManager: wm,
      worktreeRoot: '/wt',
    })
    expect(result.ok).toBe(true)
    expect(wm.ensure).not.toHaveBeenCalled()
    expect(mockRunVerify).not.toHaveBeenCalled()
  })

  it('passes when the base branch verify is green and cleans up the worktree', async () => {
    const wm = fakeWorktreeManager()
    mockRunVerify.mockResolvedValue([verifyResult(true)])
    const result = await runPreflightDriftCheck({
      config,
      repoConfig: repo(),
      worktreeManager: wm,
      worktreeRoot: '/wt',
    })
    expect(result.ok).toBe(true)
    expect(wm.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ resetToBase: true, branchName: 'orch-preflight' }),
    )
    expect(wm.remove).toHaveBeenCalledWith('/wt/org__repo/__preflight', true)
  })

  it('fails with a drift reason when the base branch verify is red', async () => {
    const wm = fakeWorktreeManager()
    mockRunVerify.mockResolvedValue([verifyResult(false)])
    const result = await runPreflightDriftCheck({
      config,
      repoConfig: repo(),
      worktreeManager: wm,
      worktreeRoot: '/wt',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("Base branch 'main' is failing preflight")
    expect(result.failedCommand).toBe('pnpm test')
    // worktree still cleaned up on the failure path
    expect(wm.remove).toHaveBeenCalled()
  })
})
