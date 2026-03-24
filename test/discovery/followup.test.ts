import { describe, it, expect, beforeEach } from 'vitest'
import { detectFollowup } from '../../src/discovery/followup.js'
import { initDatabase } from '../../src/state/db.js'

describe('detectFollowup', () => {
  let db: ReturnType<typeof initDatabase>

  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  it('returns fresh when no issue_links exist', () => {
    const result = detectFollowup(db, 'org/repo', 1)
    expect(result.mode).toBe('fresh')
    expect(result.prNumber).toBeNull()
  })

  it('returns fresh when issue_links exist but no PR number', () => {
    db.prepare('INSERT INTO issue_links (repo, issue_number, branch_slug, branch_name) VALUES (?, ?, ?, ?)').run('org/repo', 1, 'fix', 'orch/1-fix')
    const result = detectFollowup(db, 'org/repo', 1)
    expect(result.mode).toBe('fresh')
  })

  it('returns followup when PR and review_ready run exist', () => {
    db.prepare('INSERT INTO issue_links (repo, issue_number, branch_slug, branch_name, pr_number) VALUES (?, ?, ?, ?, ?)').run('org/repo', 1, 'fix', 'orch/1-fix', 10)
    db.prepare("INSERT INTO runs (id, repo, issue_number, status, planner, coder, reviewer, created_at, updated_at) VALUES (?, ?, ?, 'review_ready', 'claude', 'claude', 'claude', datetime('now'), datetime('now'))").run('run-1', 'org/repo', 1)

    const result = detectFollowup(db, 'org/repo', 1)
    expect(result.mode).toBe('followup')
    expect(result.prNumber).toBe(10)
    expect(result.branchName).toBe('orch/1-fix')
    expect(result.previousRunId).toBe('run-1')
  })

  it('returns fresh with PR when link exists but no review_ready/blocked run', () => {
    db.prepare('INSERT INTO issue_links (repo, issue_number, branch_slug, branch_name, pr_number) VALUES (?, ?, ?, ?, ?)').run('org/repo', 1, 'fix', 'orch/1-fix', 10)
    // Run exists but in 'completed' status (not review_ready or blocked)
    db.prepare("INSERT INTO runs (id, repo, issue_number, status, planner, coder, reviewer, created_at, updated_at) VALUES (?, ?, ?, 'completed', 'claude', 'claude', 'claude', datetime('now'), datetime('now'))").run('run-1', 'org/repo', 1)

    const result = detectFollowup(db, 'org/repo', 1)
    expect(result.mode).toBe('fresh')
    expect(result.prNumber).toBe(10)
  })

  it('returns followup for blocked runs too', () => {
    db.prepare('INSERT INTO issue_links (repo, issue_number, branch_slug, branch_name, pr_number) VALUES (?, ?, ?, ?, ?)').run('org/repo', 1, 'fix', 'orch/1-fix', 10)
    db.prepare("INSERT INTO runs (id, repo, issue_number, status, planner, coder, reviewer, created_at, updated_at) VALUES (?, ?, ?, 'blocked', 'claude', 'claude', 'claude', datetime('now'), datetime('now'))").run('run-1', 'org/repo', 1)

    const result = detectFollowup(db, 'org/repo', 1)
    expect(result.mode).toBe('followup')
    expect(result.previousRunId).toBe('run-1')
  })
})
