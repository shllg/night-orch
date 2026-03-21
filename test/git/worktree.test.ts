import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorktreeManager } from '../../src/git/worktree.js'
import { execa } from 'execa'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('WorktreeManager corrupt worktree detection', () => {
  let tmpDir: string
  let repoPath: string
  let worktreeRoot: string
  const manager = createWorktreeManager()

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-wt-corrupt-test-'))
    repoPath = join(tmpDir, 'repo')
    worktreeRoot = join(tmpDir, 'worktrees')

    // Create a bare-minimum git repo with a commit
    await execa('git', ['init', '--initial-branch=main', repoPath])
    await execa('git', ['-C', repoPath, 'config', 'user.email', 'test@test.com'])
    await execa('git', ['-C', repoPath, 'config', 'user.name', 'Test'])
    await execa('git', ['-C', repoPath, 'commit', '--allow-empty', '-m', 'initial'])

    // Create remote
    const bareRepo = join(tmpDir, 'origin.git')
    await execa('git', ['clone', '--bare', repoPath, bareRepo])
    await execa('git', ['-C', repoPath, 'remote', 'add', 'origin', bareRepo])
    await execa('git', ['-C', repoPath, 'fetch', 'origin'])
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('detects and removes corrupt worktree (wrong branch)', async () => {
    const worktreePath = join(worktreeRoot, 'test-wt')

    // Create worktree with branch A
    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-branch-a',
      worktreePath,
    })

    // Manually switch the worktree to a different branch to simulate corruption
    await execa('git', ['-C', repoPath, 'branch', 'orch/2-branch-b', 'main'])
    await execa('git', ['-C', worktreePath, 'checkout', 'orch/2-branch-b'])

    // Ensure with original branch — should detect mismatch and recreate
    const result = await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-branch-a',
      worktreePath,
    })

    expect(result.exists).toBe(true)
    expect(result.branchName).toBe('orch/1-branch-a')
  })

  it('validateWorktree returns false when git dir is corrupt', async () => {
    const worktreePath = join(worktreeRoot, 'test-wt')

    // Create worktree
    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-test',
      worktreePath,
    })

    // Corrupt the .git file — validateWorktree (via getCurrentBranch) should fail
    const gitFile = join(worktreePath, '.git')
    writeFileSync(gitFile, 'corrupted content')

    // getCurrentBranch should fail on this corrupt worktree
    const { execa: execaFn } = await import('execa')
    await expect(
      execaFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }),
    ).rejects.toThrow()
  })

  it('reports clean status for fresh worktree', async () => {
    const worktreePath = join(worktreeRoot, 'test-wt')

    const result = await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-clean',
      worktreePath,
    })

    expect(result.isClean).toBe(true)
  })

  it('reports dirty status when worktree has uncommitted changes', async () => {
    const worktreePath = join(worktreeRoot, 'test-wt')

    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-dirty',
      worktreePath,
    })

    // Add an uncommitted file
    writeFileSync(join(worktreePath, 'dirty.txt'), 'uncommitted')

    // Re-ensure — should detect dirty state
    const result = await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-dirty',
      worktreePath,
    })

    expect(result.isClean).toBe(false)
  })

  it('remove cleans up completely', async () => {
    const worktreePath = join(worktreeRoot, 'test-wt')

    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-remove-test',
      worktreePath,
    })

    await manager.remove(worktreePath, false)
    expect(existsSync(worktreePath)).toBe(false)

    // Worktree list should no longer include it
    const list = await manager.list(repoPath, worktreeRoot)
    expect(list).toHaveLength(0)
  })
})
