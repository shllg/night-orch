import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  fetchOrigin,
  branchExistsLocally,
  branchExistsRemotely,
  createBranch,
  createTrackingBranch,
  isGitRepo,
} from '../../src/git/repo.js'
import { branchName } from '../../src/utils/ids.js'
import { execa } from 'execa'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('git branch helpers (repo.ts)', () => {
  let tmpDir: string
  let repoPath: string
  let bareOrigin: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-branch-test-'))
    repoPath = join(tmpDir, 'repo')
    bareOrigin = join(tmpDir, 'origin.git')

    // Create repo with initial commit
    await execa('git', ['init', '--initial-branch=main', repoPath])
    await execa('git', ['-C', repoPath, 'config', 'user.email', 'test@test.com'])
    await execa('git', ['-C', repoPath, 'config', 'user.name', 'Test'])
    await execa('git', ['-C', repoPath, 'commit', '--allow-empty', '-m', 'initial'])

    // Create bare origin and add as remote
    await execa('git', ['clone', '--bare', repoPath, bareOrigin])
    await execa('git', ['-C', repoPath, 'remote', 'add', 'origin', bareOrigin])
    await execa('git', ['-C', repoPath, 'fetch', 'origin'])
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('branchExistsLocally', () => {
    it('returns true for existing branch', async () => {
      expect(await branchExistsLocally(repoPath, 'main')).toBe(true)
    })

    it('returns false for non-existent branch', async () => {
      expect(await branchExistsLocally(repoPath, 'nonexistent')).toBe(false)
    })
  })

  describe('branchExistsRemotely', () => {
    it('returns true for branch on remote', async () => {
      expect(await branchExistsRemotely(repoPath, 'main')).toBe(true)
    })

    it('returns false for branch not on remote', async () => {
      expect(await branchExistsRemotely(repoPath, 'no-such-branch')).toBe(false)
    })
  })

  describe('createBranch', () => {
    it('creates a new branch from start point', async () => {
      await createBranch(repoPath, 'feature-1', 'main')
      expect(await branchExistsLocally(repoPath, 'feature-1')).toBe(true)
    })

    it('throws on invalid start point', async () => {
      await expect(createBranch(repoPath, 'feature-2', 'nonexistent')).rejects.toThrow()
    })
  })

  describe('createTrackingBranch', () => {
    it('creates local branch tracking remote', async () => {
      // Push a branch to origin first
      await execa('git', ['-C', repoPath, 'branch', 'remote-feature', 'main'])
      await execa('git', ['-C', repoPath, 'push', 'origin', 'remote-feature'])
      await execa('git', ['-C', repoPath, 'branch', '-D', 'remote-feature'])
      await execa('git', ['-C', repoPath, 'fetch', 'origin'])

      await createTrackingBranch(repoPath, 'remote-feature')
      expect(await branchExistsLocally(repoPath, 'remote-feature')).toBe(true)
    })
  })

  describe('fetchOrigin', () => {
    it('fetches without error', async () => {
      await expect(fetchOrigin(repoPath)).resolves.toBeUndefined()
    })
  })

  describe('isGitRepo', () => {
    it('returns true for a git repo', async () => {
      expect(await isGitRepo(repoPath)).toBe(true)
    })

    it('returns false for a non-repo directory', async () => {
      const nonRepo = join(tmpDir, 'not-a-repo')
      mkdirSync(nonRepo, { recursive: true })
      expect(await isGitRepo(nonRepo)).toBe(false)
    })
  })
})

describe('branchName (utils/ids.ts)', () => {
  it('builds branch name from prefix, issue number, and slug', () => {
    expect(branchName('orch', 42, 'fix-login')).toBe('orch/42-fix-login')
  })

  it('handles custom prefix', () => {
    expect(branchName('night', 1, 'test')).toBe('night/1-test')
  })
})
