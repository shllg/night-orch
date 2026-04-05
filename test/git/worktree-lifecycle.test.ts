import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorktreeManager } from '../../src/git/worktree.js'
import { execa } from 'execa'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('WorktreeManager lifecycle', () => {
  let tmpDir: string
  let repoPath: string
  let worktreeRoot: string
  const manager = createWorktreeManager()

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-wt-test-'))
    repoPath = join(tmpDir, 'repo')
    worktreeRoot = join(tmpDir, 'worktrees')

    // Create a bare-minimum git repo with a commit
    await execa('git', ['init', '--initial-branch=main', repoPath])
    await execa('git', ['-C', repoPath, 'config', 'user.email', 'test@test.com'])
    await execa('git', ['-C', repoPath, 'config', 'user.name', 'Test'])
    await execa('git', ['-C', repoPath, 'commit', '--allow-empty', '-m', 'initial'])

    // Create a "remote" (local bare repo) so fetch/merge work
    const bareRepo = join(tmpDir, 'origin.git')
    await execa('git', ['clone', '--bare', repoPath, bareRepo])
    await execa('git', ['-C', repoPath, 'remote', 'add', 'origin', bareRepo])
    await execa('git', ['-C', repoPath, 'fetch', 'origin'])
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a new worktree with a new branch', async () => {
    const worktreePath = join(worktreeRoot, 'test-wt')
    const result = await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-test-issue',
      worktreePath,
    })

    expect(result.exists).toBe(true)
    expect(result.branchName).toBe('orch/1-test-issue')
    expect(existsSync(worktreePath)).toBe(true)
  })

  it('reuses existing worktree for same branch', async () => {
    const worktreePath = join(worktreeRoot, 'test-wt')
    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-test-issue',
      worktreePath,
    })

    // Second call should reuse
    const result = await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-test-issue',
      worktreePath,
    })

    expect(result.exists).toBe(true)
  })

  it('removes worktree', async () => {
    const worktreePath = join(worktreeRoot, 'test-wt')
    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-test-issue',
      worktreePath,
    })

    await manager.remove(worktreePath, false)
    expect(existsSync(worktreePath)).toBe(false)
  })

  it('removes worktree and deletes branch', async () => {
    const worktreePath = join(worktreeRoot, 'test-wt')
    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-test-issue',
      worktreePath,
    })

    await manager.remove(worktreePath, true)

    // Branch should be deleted
    const { stdout } = await execa('git', ['-C', repoPath, 'branch', '--list', 'orch/1-test-issue'])
    expect(stdout.trim()).toBe('')
  })

  it('lists worktrees filtered by root', async () => {
    const wt1 = join(worktreeRoot, 'wt1')
    const wt2 = join(worktreeRoot, 'wt2')

    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/1-issue-a',
      worktreePath: wt1,
    })
    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName: 'orch/2-issue-b',
      worktreePath: wt2,
    })

    const list = await manager.list(repoPath, worktreeRoot)
    expect(list.length).toBe(2)
  })

  it('creates new branch from origin/base even when local base has extra commits', async () => {
    // Create a local-only commit on main that is not pushed to origin.
    const localOnlyFile = join(repoPath, 'local-only.txt')
    writeFileSync(localOnlyFile, 'local only')
    await execa('git', ['-C', repoPath, 'add', 'local-only.txt'])
    await execa('git', ['-C', repoPath, 'commit', '-m', 'local-only-main-commit'])

    const worktreePath = join(worktreeRoot, 'test-wt')
    const branchName = 'orch/3-remote-base'
    await manager.ensure({
      repoLocalPath: repoPath,
      baseBranch: 'main',
      branchName,
      worktreePath,
    })

    const { stdout: branchSha } = await execa('git', ['-C', repoPath, 'rev-parse', branchName])
    const { stdout: localMainSha } = await execa('git', ['-C', repoPath, 'rev-parse', 'main'])
    const { stdout: remoteMainSha } = await execa('git', ['-C', repoPath, 'rev-parse', 'origin/main'])

    expect(branchSha.trim()).toBe(remoteMainSha.trim())
    expect(branchSha.trim()).not.toBe(localMainSha.trim())
  })
})
