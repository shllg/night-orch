import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { autoRebase, type RebaseTarget } from '../../src/ops/rebase.js'
import type { ConflictResolver } from '../../src/ops/conflict-types.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'night-orch',
      GIT_AUTHOR_EMAIL: 'night-orch@example.com',
      GIT_COMMITTER_NAME: 'night-orch',
      GIT_COMMITTER_EMAIL: 'night-orch@example.com',
    },
  }).trim()
}

describe('autoRebase integration', () => {
  let tmpDir: string
  let remotePath: string
  let repoPath: string
  let upstreamPath: string
  let target: RebaseTarget

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-rebase-int-'))
    remotePath = join(tmpDir, 'remote.git')
    repoPath = join(tmpDir, 'repo')
    upstreamPath = join(tmpDir, 'upstream')

    mkdirSync(remotePath, { recursive: true })
    git(tmpDir, 'init', '--bare', remotePath)
    git(tmpDir, 'clone', remotePath, repoPath)

    writeFileSync(join(repoPath, 'conflict.ts'), [
      'export const shared = "base"',
      'export const feature = "base"',
      '',
    ].join('\n'))
    git(repoPath, 'add', 'conflict.ts')
    git(repoPath, 'commit', '-m', 'initial')
    git(repoPath, 'branch', '-M', 'main')
    git(repoPath, 'push', '-u', 'origin', 'main')

    git(repoPath, 'checkout', '-b', 'feature')
    writeFileSync(join(repoPath, 'conflict.ts'), [
      'export const shared = "feature"',
      'export const feature = "branch"',
      '',
    ].join('\n'))
    git(repoPath, 'add', 'conflict.ts')
    git(repoPath, 'commit', '-m', 'feature change')
    git(repoPath, 'push', '-u', 'origin', 'feature')

    git(tmpDir, 'clone', remotePath, upstreamPath)
    git(upstreamPath, 'checkout', 'main')
    writeFileSync(join(upstreamPath, 'conflict.ts'), [
      'export const shared = "main"',
      'export const feature = "base"',
      '',
    ].join('\n'))
    git(upstreamPath, 'add', 'conflict.ts')
    git(upstreamPath, 'commit', '-m', 'main change')
    git(upstreamPath, 'push', 'origin', 'main')

    git(repoPath, 'checkout', 'feature')

    target = {
      repo: 'org/repo',
      issueNumber: 1,
      prNumber: 10,
      branchName: 'feature',
      baseBranch: 'main',
      worktreePath: repoPath,
    }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('continues and pushes when the resolver returns a valid file', async () => {
    const resolver: ConflictResolver = {
      maxAttempts: 2,
      maxFiles: 5,
      resolveConflicts: async () => ({
        ok: true,
        files: [{
          path: 'conflict.ts',
          resolved: [
            'export const shared = "main"',
            'export const feature = "branch"',
            '',
          ].join('\n'),
        }],
      }),
    }

    const result = await autoRebase(target, repoPath, 'rebase', {
      resolver,
      context: {
        issueTitle: 'Resolve conflict',
        issueBody: 'Use both sides where possible.',
      },
    })

    expect(result.result).toBe('rebased')
    expect(result.resolution).toEqual({
      attempted: true,
      outcome: 'resolved',
      files: ['conflict.ts'],
    })
    expect(readFileSync(join(repoPath, 'conflict.ts'), 'utf-8')).toContain('export const feature = "branch"')
    expect(git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature')
  })

  it('aborts and returns conflict when validation fails', async () => {
    const resolver: ConflictResolver = {
      maxAttempts: 2,
      maxFiles: 5,
      resolveConflicts: async () => ({
        ok: true,
        files: [{
          path: 'conflict.ts',
          resolved: '<<<<<<< still bad\n',
        }],
      }),
    }

    const result = await autoRebase(target, repoPath, 'rebase', {
      resolver,
      context: {
        issueTitle: 'Resolve conflict',
        issueBody: 'Use both sides where possible.',
      },
    })

    expect(result.result).toBe('conflict')
    expect(result.resolution).toMatchObject({
      attempted: true,
      outcome: 'validation_failed',
    })
    expect(git(repoPath, 'status', '--porcelain')).toBe('')
  })

  it('aborts and returns conflict when the resolver throws', async () => {
    const resolver: ConflictResolver = {
      maxAttempts: 2,
      maxFiles: 5,
      resolveConflicts: async () => {
        throw new Error('resolver boom')
      },
    }

    const result = await autoRebase(target, repoPath, 'rebase', {
      resolver,
      context: {
        issueTitle: 'Resolve conflict',
        issueBody: 'Use both sides where possible.',
      },
    })

    expect(result.result).toBe('conflict')
    expect(result.resolution).toMatchObject({
      attempted: true,
      outcome: 'error',
    })
    expect(git(repoPath, 'status', '--porcelain')).toBe('')
  })

  it('falls back to the existing conflict path when no resolver is provided', async () => {
    const result = await autoRebase(target, repoPath, 'rebase')

    expect(result.result).toBe('conflict')
    expect(result.resolution).toEqual({
      attempted: false,
      outcome: 'unresolved',
    })
    expect(git(repoPath, 'status', '--porcelain')).toBe('')
  })
})
