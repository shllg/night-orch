import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { handleReaction } from '../../src/reactions/handler.js'
import type { Reaction } from '../../src/reactions/types.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { RepoConfig } from '../../src/config/schema.js'

function makeForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    listEligibleIssues: vi.fn(),
    getIssue: vi.fn().mockResolvedValue({ number: 1, labels: [], title: 't', body: '', state: 'open', url: '' }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn(),
    validateAuth: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    findPRByBranch: vi.fn(),
    getPRDiff: vi.fn(),
    listIssueComments: vi.fn(),
    updateComment: vi.fn(),
    listPRReviews: vi.fn().mockResolvedValue([]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    ...overrides,
  } as unknown as ForgeAdapter
}

const repoConfig = {
  labels: {},
  kanban: undefined,
} as unknown as Pick<RepoConfig, 'labels' | 'kanban'>

function makeReaction(type: Reaction['type']): Reaction {
  return {
    type,
    repo: 'foo/bar',
    prNumber: 42,
    issueNumber: 7,
    summary: `${type} summary`,
    context: `${type} context`,
    detectedAt: '2026-04-13T00:00:00.000Z',
  }
}

describe('handleReaction', () => {
  let tmpDir: string
  let db: Database.Database
  let runs: RunManager

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'night-orch-reaction-handler-test-'))
    db = initDatabase(join(tmpDir, 'test.db'))
    runs = new RunManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedReviewReadyRun(): string {
    const row = runs.create({
      repo: 'foo/bar',
      issueNumber: 7,
      issueNodeId: null,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runs.update(row.id, {
      status: 'review_ready',
      branchName: 'feature/x',
      prNumber: 42,
      phaseData: { issueRepo: 'foo/bar' },
    })
    return row.id
  }

  it('merge_conflict reaction creates a new attempt with intent=rebase and terminates the previous one', async () => {
    const prevId = seedReviewReadyRun()
    const forge = makeForge()

    await handleReaction(makeReaction('merge_conflict'), { db, forge, runManager: runs, repoConfig })

    const prevTerm = db.prepare('SELECT terminated_at FROM runs WHERE id = ?').get(prevId) as {
      terminated_at: string | null
    }
    expect(prevTerm.terminated_at).not.toBeNull()

    const newRun = runs.getByRepoAndIssue('foo/bar', 7)
    expect(newRun).not.toBeNull()
    expect(newRun!.id).not.toBe(prevId)
    expect(newRun!.status).toBe('queued')
    expect(newRun!.branchName).toBe('feature/x')
    expect(newRun!.prNumber).toBe(42)

    const controlPayload = db
      .prepare('SELECT control_payload FROM runs WHERE id = ?')
      .get(newRun!.id) as { control_payload: string | null }
    expect(controlPayload.control_payload).toContain('"preserveBranchState":true')

    const userAction = db
      .prepare(
        "SELECT data FROM run_log_events WHERE run_id = ? AND event_type = 'user_action'",
      )
      .get(newRun!.id) as { data: string } | undefined
    expect(userAction?.data).toContain('"kind":"rebase"')
    expect(userAction?.data).toContain('reaction:merge_conflict')
  })

  it('non-merge_conflict reactions flip the same run in place to queued', async () => {
    const prevId = seedReviewReadyRun()
    const forge = makeForge()

    await handleReaction(makeReaction('ci_failure'), { db, forge, runManager: runs, repoConfig })

    const same = runs.getByRepoAndIssue('foo/bar', 7)
    expect(same!.id).toBe(prevId)
    expect(same!.status).toBe('queued')
    expect(same!.phaseData?.reactionType).toBe('ci_failure')

    const term = db.prepare('SELECT terminated_at FROM runs WHERE id = ?').get(prevId) as {
      terminated_at: string | null
    }
    expect(term.terminated_at).toBeNull()
  })

  it('ignores reactions when the run is not in review_ready state', async () => {
    const row = runs.create({
      repo: 'foo/bar',
      issueNumber: 7,
      issueNodeId: null,
      planner: 'claude',
      coder: 'claude',
      reviewer: 'claude',
    })
    runs.update(row.id, { status: 'running' })
    const forge = makeForge()

    await handleReaction(makeReaction('merge_conflict'), { db, forge, runManager: runs, repoConfig })

    const after = runs.getByRepoAndIssue('foo/bar', 7)
    expect(after!.id).toBe(row.id)
    expect(after!.status).toBe('running')
  })

  it('does nothing when no run exists for the issue', async () => {
    const forge = makeForge()
    await expect(
      handleReaction(makeReaction('merge_conflict'), { db, forge, runManager: runs, repoConfig }),
    ).resolves.not.toThrow()
    expect(forge.getIssue).not.toHaveBeenCalled()
  })
})
