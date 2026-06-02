import type Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { queueRebase } from '../../src/ops/rebase-and-check.js'
import { initDatabase } from '../../src/state/db.js'
import { RunManager } from '../../src/state/runs.js'
import { makeTestRepoConfig } from '../helpers/factories.js'

function seedRun(db: Database.Database, opts: { issueNumber: number; prNumber: number; status?: 'review_ready' | 'blocked' | 'error' } = { issueNumber: 7, prNumber: 100 }): string {
  const mgr = new RunManager(db)
  const run = mgr.create({
    repo: 'org/repo',
    issueNumber: opts.issueNumber,
    issueNodeId: `node-${opts.issueNumber}`,
    planner: 'claude',
    coder: 'codex',
    reviewer: 'codex',
  })
  mgr.updateWorktree(run.id, { branchName: `orch/org-repo/${opts.issueNumber}` })
  mgr.updatePullRequest(run.id, { prNumber: opts.prNumber })
  mgr.updateLifecycle(run.id, { status: opts.status ?? 'review_ready' })
  return run.id
}

interface RecordedComment { repo: string; issueNumber: number; body: string }

interface UserActionRecord {
  actor: string
  data: Record<string, unknown>
}

function latestUserAction(db: Database.Database, runId: string): UserActionRecord | null {
  const row = db
    .prepare(
      `SELECT role, data FROM run_log_events
       WHERE run_id = ? AND event_type = 'user_action'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as { role: string | null; data: string | null } | undefined
  if (!row) return null
  const data = row.data ? (JSON.parse(row.data) as Record<string, unknown>) : {}
  return { actor: row.role ?? '', data }
}

function makeForge(opts: { findCommentsResult?: unknown[] } = {}) {
  const comments: RecordedComment[] = []
  const forge = {
    getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn(async (repo: string, issueNumber: number, body: string) => {
      comments.push({ repo, issueNumber, body })
    }),
    listIssueComments: vi.fn().mockResolvedValue(opts.findCommentsResult ?? []),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
  } as never
  return { forge, comments }
}

describe('queueRebase', () => {
  it('queues a rebase attempt and posts the generic comment for manual triggers', async () => {
    const db = initDatabase(':memory:')
    seedRun(db)
    const { forge, comments } = makeForge()

    const result = await queueRebase(db, forge, makeTestRepoConfig(), 7, '')

    expect(result.queued).toBe(true)
    const joined = comments.map((c) => c.body).join('\n')
    expect(joined).toMatch(/Queued for rebase and re-evaluation/i)
    expect(joined).not.toMatch(/#\d+ merged/i)
  })

  it('emits a fan-out-flavoured comment referencing the source PR when triggeredBy is set', async () => {
    const db = initDatabase(':memory:')
    seedRun(db)
    const { forge, comments } = makeForge()

    await queueRebase(db, forge, makeTestRepoConfig({ baseBranch: 'develop' }), 7, '', {
      triggeredBy: { kind: 'merge-fanout', sourcePr: 42 },
    })

    const joined = comments.map((c) => c.body).join('\n')
    expect(joined).toMatch(/#42 merged/)
  })

  it('records actor=fanout when triggeredBy is set and actor is not overridden', async () => {
    const db = initDatabase(':memory:')
    const runId = seedRun(db)
    const { forge } = makeForge()

    await queueRebase(db, forge, makeTestRepoConfig(), 7, '', {
      triggeredBy: { kind: 'merge-fanout', sourcePr: 42 },
    })

    const newRunId = new RunManager(db).getByRepoAndIssue('org/repo', 7)?.id
    expect(newRunId).toBeTruthy()
    expect(newRunId).not.toBe(runId)

    const event = latestUserAction(db, newRunId!)
    expect(event?.actor).toBe('fanout')
    expect(event?.data.kind).toBe('rebase')
    expect(event?.data.triggeredBy).toEqual({ kind: 'merge-fanout', sourcePr: 42 })
  })

  it('records actor=manual when triggeredBy is unset', async () => {
    const db = initDatabase(':memory:')
    seedRun(db)
    const { forge } = makeForge()

    await queueRebase(db, forge, makeTestRepoConfig(), 7, '')

    const newRunId = new RunManager(db).getByRepoAndIssue('org/repo', 7)!.id
    expect(latestUserAction(db, newRunId)?.actor).toBe('manual')
  })

  it('honours an explicit actor override regardless of triggeredBy', async () => {
    const db = initDatabase(':memory:')
    seedRun(db)
    const { forge } = makeForge()

    await queueRebase(db, forge, makeTestRepoConfig(), 7, '', {
      actor: 'cli',
      triggeredBy: { kind: 'merge-fanout', sourcePr: 9 },
    })

    const newRunId = new RunManager(db).getByRepoAndIssue('org/repo', 7)!.id
    expect(latestUserAction(db, newRunId)?.actor).toBe('cli')
  })

  it('returns chain_exhausted with a fan-out-specific PR comment when the attempt chain is full', async () => {
    const db = initDatabase(':memory:')
    seedRun(db)
    const { forge, comments } = makeForge()

    // Force the chain to be considered full by setting maxAttemptChainLength to 0.
    const result = await queueRebase(db, forge, makeTestRepoConfig(), 7, '', {
      triggeredBy: { kind: 'merge-fanout', sourcePr: 42 },
      maxAttemptChainLength: 0,
    })

    expect(result.queued).toBe(false)
    expect(result.reason).toBe('chain_exhausted')
    const joined = comments.map((c) => c.body).join('\n')
    expect(joined).toMatch(/attempt chain limit/i)
    expect(joined).toMatch(/#42/)
  })

  it('does not post the chain-exhaustion comment for manual triggers', async () => {
    const db = initDatabase(':memory:')
    seedRun(db)
    const { forge, comments } = makeForge()

    const result = await queueRebase(db, forge, makeTestRepoConfig(), 7, '', {
      maxAttemptChainLength: 0,
    })

    expect(result.queued).toBe(false)
    expect(result.reason).toBe('chain_exhausted')
    const joined = comments.map((c) => c.body).join('\n')
    expect(joined).not.toMatch(/attempt chain limit/i)
  })

  it('returns "Run is already running" when the latest run is in flight', async () => {
    const db = initDatabase(':memory:')
    const runId = seedRun(db)
    new RunManager(db).updateLifecycle(runId, { status: 'running' })
    const { forge } = makeForge()

    const result = await queueRebase(db, forge, makeTestRepoConfig(), 7, '')

    expect(result.queued).toBe(false)
    expect(result.reason).toBe('Run is already running')
  })

  it('returns "No run with branch found" when the run lacks a branch name', async () => {
    const db = initDatabase(':memory:')
    const mgr = new RunManager(db)
    mgr.create({ repo: 'org/repo', issueNumber: 7, issueNodeId: 'node-7', planner: 'claude', coder: 'codex', reviewer: 'codex' })
    const { forge } = makeForge()

    const result = await queueRebase(db, forge, makeTestRepoConfig(), 7, '')

    expect(result.queued).toBe(false)
    expect(result.reason).toBe('No run with branch found for this issue')
  })

  it('forwards strategyOverride into the queued attempt control payload', async () => {
    const db = initDatabase(':memory:')
    seedRun(db)
    const { forge } = makeForge()

    await queueRebase(db, forge, makeTestRepoConfig(), 7, '', { strategyOverride: 'merge' })

    const newRunId = new RunManager(db).getByRepoAndIssue('org/repo', 7)!.id
    const row = db.prepare('SELECT control_payload FROM runs WHERE id = ?').get(newRunId) as { control_payload: string } | undefined
    expect(row?.control_payload).toBeTruthy()
    const parsed = JSON.parse(row!.control_payload) as { updateStrategy?: string }
    expect(parsed.updateStrategy).toBe('merge')
  })
})
