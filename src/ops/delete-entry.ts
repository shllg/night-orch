import type Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Config } from '../config/schema.js'
import { createWorktreeManager } from '../git/worktree.js'
import { branchExistsLocally } from '../git/repo.js'
import { buildWorktreePath } from '../git/slug.js'
import { runGit } from '../git/process.js'
import { branchName as buildBranchName } from '../utils/ids.js'
import { resolveIssueRepo } from '../utils/issue-repo.js'
import { logger } from '../utils/logger.js'

export interface DeleteIssueEntryOptions {
  dryRun: boolean
  force: boolean
}

export interface DeleteIssueEntryResult {
  repo: string
  issueNumber: number
  dryRun: boolean
  found: boolean
  runsDeleted: number
  issuesDeleted: number
  issueLinksDeleted: number
  leasesDeleted: number
  commandTrackingDeleted: number
  eventsDeleted: number
  agentEventsDeleted: number
  worktreesRemoved: string[]
  worktreesFailed: string[]
}

interface RunDeleteRow {
  id: string
  status: string
  branch_name: string | null
  worktree_path: string | null
  phase_data: string | null
}

interface IssueDeleteRow {
  worktree_path: string | null
  branch_name: string | null
  branch_slug: string | null
}

interface IssueLinkDeleteRow {
  branch_name: string
  branch_slug: string
}

interface ActiveRunRow {
  id: string
  repo: string
  status: string
  phase_data: string | null
}

interface ActiveIssueRepoConflict {
  id: string
  repo: string
  status: string
  issueRepo: string
}

interface DeleteCounts {
  runsDeleted: number
  issuesDeleted: number
  issueLinksDeleted: number
  leasesDeleted: number
  commandTrackingDeleted: number
  eventsDeleted: number
  agentEventsDeleted: number
}

const DEFAULT_OPTIONS: DeleteIssueEntryOptions = {
  dryRun: false,
  force: false,
}

const ACTIVE_RUN_STATUS_SQL = "'queued', 'running', 'blocked', 'review_ready', 'error'"

export class DeleteIssueEntryEngine {
  constructor(
    private db: Database.Database,
    private config: Config,
  ) {}

  async deleteEntry(
    repo: string,
    issueNumber: number,
    options: Partial<DeleteIssueEntryOptions> = {},
  ): Promise<DeleteIssueEntryResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const runRows = this.db
      .prepare(
        `SELECT id, status, branch_name, worktree_path, phase_data
         FROM runs
         WHERE repo = ?
           AND issue_number = ?`,
      )
      .all(repo, issueNumber) as RunDeleteRow[]

    if (!opts.force) {
      const running = runRows.find((row) => row.status === 'running')
      if (running) {
        throw new Error(
          `Cannot delete ${repo}#${issueNumber}: run ${running.id} is currently running (use force to override)`,
        )
      }
    }

    const issueRows = this.db
      .prepare(
        `SELECT worktree_path, branch_name, branch_slug
         FROM issues
         WHERE repo = ?
           AND issue_number = ?`,
      )
      .all(repo, issueNumber) as IssueDeleteRow[]

    const issueLinkRows = this.db
      .prepare(
        `SELECT branch_name, branch_slug
         FROM issue_links
         WHERE repo = ?
           AND issue_number = ?`,
      )
      .all(repo, issueNumber) as IssueLinkDeleteRow[]

    const issueRepos = this.collectIssueRepos(repo, runRows)
    const activeIssueRepoConflicts = this.collectActiveIssueRepoConflicts(
      repo,
      issueNumber,
      issueRepos,
    )
    if (activeIssueRepoConflicts.length > 0 && !opts.force) {
      const details = activeIssueRepoConflicts
        .map((conflict) => `${conflict.repo} (run ${conflict.id}, ${conflict.status})`)
        .join(', ')
      throw new Error(
        `Cannot delete ${repo}#${issueNumber}: shared issue-scoped state is in use by active run(s): ${details} (use force to delete run-local state while preserving shared rows)`,
      )
    }

    const protectedIssueRepos = new Set(activeIssueRepoConflicts.map((conflict) => conflict.issueRepo))
    const issueReposToDelete = issueRepos.filter((issueRepo) => !protectedIssueRepos.has(issueRepo))
    if (protectedIssueRepos.size > 0) {
      logger.warn(
        { repo, issueNumber, protectedIssueRepos: [...protectedIssueRepos] },
        'Preserving shared issue-scoped rows because they are referenced by active runs in other repos',
      )
    }

    const repoConfig = this.config.repos.find((r) => r.repo === repo)
    const branchPrefix = repoConfig?.branchPrefix ?? null
    const branchNames = this.collectBranchNames(issueNumber, runRows, issueRows, issueLinkRows, branchPrefix)
    const worktreePaths = this.collectWorktreePaths(repo, issueNumber, runRows, issueRows)
    const runIds = runRows.map((row) => row.id)

    const allCounts = this.computeDeleteCounts(runIds, issueRepos, repo, issueNumber, true)
    const dryRunCounts = this.computeDeleteCounts(runIds, issueReposToDelete, repo, issueNumber, true)
    const found = this.hasAnyStoredState(allCounts) || worktreePaths.length > 0

    const counts = opts.dryRun
      ? dryRunCounts
      : this.deleteRows(runIds, issueReposToDelete, repo, issueNumber)

    const worktreesRemoved: string[] = []
    const worktreesFailed: string[] = []
    const repoLocalPath = repoConfig?.localPath ?? null
    if (worktreePaths.length > 0) {
      for (const worktreePath of worktreePaths) {
        const result = await this.removeWorktreeBestEffort(
          worktreePath,
          repoLocalPath,
          this.config.storage.worktreeRoot,
          opts.dryRun,
        )
        if (result.ok) {
          worktreesRemoved.push(worktreePath)
        } else {
          worktreesFailed.push(`${worktreePath}: ${result.reason}`)
        }
      }
    }

    if (branchNames.length > 0) {
      const branchWarnings = await this.removeBranchesBestEffort(
        branchNames,
        repoLocalPath,
        opts.dryRun,
      )
      worktreesFailed.push(...branchWarnings)
    }

    return {
      repo,
      issueNumber,
      dryRun: opts.dryRun,
      found,
      ...counts,
      worktreesRemoved,
      worktreesFailed,
    }
  }

  private collectIssueRepos(repo: string, runRows: RunDeleteRow[]): string[] {
    const repos = new Set<string>([repo])
    for (const row of runRows) {
      const phaseData = this.parsePhaseData(row.phase_data)
      repos.add(resolveIssueRepo(phaseData, repo))
    }
    return [...repos]
  }

  private collectActiveIssueRepoConflicts(
    repo: string,
    issueNumber: number,
    issueRepos: string[],
  ): ActiveIssueRepoConflict[] {
    if (issueRepos.length === 0) return []
    const issueRepoSet = new Set(issueRepos)
    const rows = this.db
      .prepare(
        `SELECT id, repo, status, phase_data
         FROM runs
         WHERE issue_number = ?
           AND repo != ?
           AND status IN (${ACTIVE_RUN_STATUS_SQL})`,
      )
      .all(issueNumber, repo) as ActiveRunRow[]

    const conflicts: ActiveIssueRepoConflict[] = []
    for (const row of rows) {
      const phaseData = this.parsePhaseData(row.phase_data)
      const issueRepo = resolveIssueRepo(phaseData, row.repo)
      if (!issueRepoSet.has(issueRepo)) continue
      conflicts.push({
        id: row.id,
        repo: row.repo,
        status: row.status,
        issueRepo,
      })
    }
    return conflicts
  }

  private collectBranchNames(
    issueNumber: number,
    runRows: RunDeleteRow[],
    issueRows: IssueDeleteRow[],
    issueLinkRows: IssueLinkDeleteRow[],
    branchPrefix: string | null,
  ): string[] {
    const branches = new Set<string>()
    for (const row of runRows) {
      this.addBranchIfPresent(branches, row.branch_name)
    }

    for (const row of issueRows) {
      this.addBranchIfPresent(branches, row.branch_name)
      if (branchPrefix && row.branch_slug && row.branch_slug.length > 0) {
        branches.add(buildBranchName(branchPrefix, issueNumber, row.branch_slug))
      }
    }

    for (const row of issueLinkRows) {
      this.addBranchIfPresent(branches, row.branch_name)
      if (branchPrefix && row.branch_slug.length > 0) {
        branches.add(buildBranchName(branchPrefix, issueNumber, row.branch_slug))
      }
    }

    return [...branches]
  }

  private addBranchIfPresent(branches: Set<string>, branchName: string | null): void {
    if (!branchName) return
    const normalized = branchName.trim()
    if (normalized.length === 0) return
    branches.add(normalized)
  }

  private parsePhaseData(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null
      }
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }

  private collectWorktreePaths(
    repo: string,
    issueNumber: number,
    runRows: RunDeleteRow[],
    issueRows: IssueDeleteRow[],
  ): string[] {
    const paths = new Set<string>()

    for (const row of runRows) {
      if (row.worktree_path) paths.add(row.worktree_path)
    }
    for (const row of issueRows) {
      if (row.worktree_path) paths.add(row.worktree_path)
    }

    const deterministic = buildWorktreePath(this.config.storage.worktreeRoot, repo, issueNumber)
    if (existsSync(deterministic)) {
      paths.add(deterministic)
    }

    return [...paths]
  }

  private hasAnyStoredState(counts: DeleteCounts): boolean {
    return counts.runsDeleted > 0
      || counts.issuesDeleted > 0
      || counts.issueLinksDeleted > 0
      || counts.leasesDeleted > 0
      || counts.commandTrackingDeleted > 0
      || counts.eventsDeleted > 0
      || counts.agentEventsDeleted > 0
  }

  private computeDeleteCounts(
    runIds: string[],
    issueRepos: string[],
    repo: string,
    issueNumber: number,
    dryRun: boolean,
  ): DeleteCounts {
    const runsDeleted = dryRun
      ? this.countRuns(repo, issueNumber)
      : 0
    const issuesDeleted = dryRun
      ? this.countIssueScopedRows('issues', issueRepos, issueNumber)
      : 0
    const issueLinksDeleted = dryRun
      ? this.countIssueScopedRows('issue_links', issueRepos, issueNumber)
      : 0
    const leasesDeleted = dryRun
      ? this.countIssueScopedRows('leases', issueRepos, issueNumber)
      : 0
    const commandTrackingDeleted = dryRun
      ? this.countIssueScopedRows('command_tracking', issueRepos, issueNumber)
      : 0
    const eventsDeleted = dryRun
      ? this.countRunScopedRows('events', runIds)
      : 0
    const agentEventsDeleted = dryRun
      ? this.countRunScopedRows('agent_events', runIds)
      : 0

    return {
      runsDeleted,
      issuesDeleted,
      issueLinksDeleted,
      leasesDeleted,
      commandTrackingDeleted,
      eventsDeleted,
      agentEventsDeleted,
    }
  }

  private deleteRows(
    runIds: string[],
    issueRepos: string[],
    repo: string,
    issueNumber: number,
  ): DeleteCounts {
    const tx = this.db.transaction((): DeleteCounts => {
      let eventsDeleted = 0
      let agentEventsDeleted = 0
      if (runIds.length > 0) {
        eventsDeleted = this.deleteRunScopedRows('events', runIds)
        agentEventsDeleted = this.deleteRunScopedRows('agent_events', runIds)
      }

      const commandTrackingDeleted = this.deleteIssueScopedRows('command_tracking', issueRepos, issueNumber)
      const leasesDeleted = this.deleteIssueScopedRows('leases', issueRepos, issueNumber)
      const issueLinksDeleted = this.deleteIssueScopedRows('issue_links', issueRepos, issueNumber)
      const issuesDeleted = this.deleteIssueScopedRows('issues', issueRepos, issueNumber)

      const runsDeleted = this.db
        .prepare(
          `DELETE FROM runs
           WHERE repo = ?
             AND issue_number = ?`,
        )
        .run(repo, issueNumber)
        .changes

      return {
        runsDeleted,
        issuesDeleted,
        issueLinksDeleted,
        leasesDeleted,
        commandTrackingDeleted,
        eventsDeleted,
        agentEventsDeleted,
      }
    })

    return tx()
  }

  private deleteRunScopedRows(table: 'events' | 'agent_events', runIds: string[]): number {
    if (runIds.length === 0) return 0
    const placeholders = runIds.map(() => '?').join(', ')
    return this.db
      .prepare(`DELETE FROM ${table} WHERE run_id IN (${placeholders})`)
      .run(...runIds)
      .changes
  }

  private deleteIssueScopedRows(
    table: 'issues' | 'issue_links' | 'leases' | 'command_tracking',
    issueRepos: string[],
    issueNumber: number,
  ): number {
    if (issueRepos.length === 0) return 0
    const placeholders = issueRepos.map(() => '?').join(', ')
    return this.db
      .prepare(`DELETE FROM ${table} WHERE issue_number = ? AND repo IN (${placeholders})`)
      .run(issueNumber, ...issueRepos)
      .changes
  }

  private countRuns(repo: string, issueNumber: number): number {
    return (this.db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM runs
         WHERE repo = ?
           AND issue_number = ?`,
      )
      .get(repo, issueNumber) as { c: number }).c
  }

  private countIssueScopedRows(
    table: 'issues' | 'issue_links' | 'leases' | 'command_tracking',
    issueRepos: string[],
    issueNumber: number,
  ): number {
    if (issueRepos.length === 0) return 0
    const placeholders = issueRepos.map(() => '?').join(', ')
    return (this.db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE issue_number = ? AND repo IN (${placeholders})`)
      .get(issueNumber, ...issueRepos) as { c: number }).c
  }

  private countRunScopedRows(table: 'events' | 'agent_events', runIds: string[]): number {
    if (runIds.length === 0) return 0
    const placeholders = runIds.map(() => '?').join(', ')
    return (this.db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE run_id IN (${placeholders})`)
      .get(...runIds) as { c: number }).c
  }

  private async removeWorktreeBestEffort(
    worktreePath: string,
    repoLocalPath: string | null,
    worktreeRoot: string,
    dryRun: boolean,
  ): Promise<{ ok: boolean; reason: string }> {
    const resolvedPath = resolve(worktreePath)
    const resolvedRoot = resolve(worktreeRoot)
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}/`)) {
      return { ok: false, reason: 'outside configured worktree root' }
    }

    if (dryRun) {
      return { ok: true, reason: 'dry run' }
    }

    const manager = createWorktreeManager()

    try {
      await manager.remove(worktreePath, true)
      return { ok: true, reason: 'removed by worktree manager' }
    } catch (err) {
      logger.debug({ worktreePath, err }, 'Primary worktree removal failed; attempting fallback cleanup')
    }

    if (repoLocalPath) {
      try {
        await runGit(['worktree', 'remove', worktreePath, '--force'], { cwd: repoLocalPath, reject: false })
        await runGit(['worktree', 'prune'], { cwd: repoLocalPath, reject: false })
      } catch (err) {
        logger.debug({ worktreePath, repoLocalPath, err }, 'Fallback git worktree cleanup failed')
      }
    }

    try {
      await rm(worktreePath, { recursive: true, force: true })
    } catch (err) {
      logger.debug({ worktreePath, err }, 'Filesystem worktree removal failed')
    }

    if (!existsSync(worktreePath)) {
      return { ok: true, reason: 'removed by fallback cleanup' }
    }
    return { ok: false, reason: 'worktree path still exists after cleanup attempts' }
  }

  private async removeBranchesBestEffort(
    branchNames: string[],
    repoLocalPath: string | null,
    dryRun: boolean,
  ): Promise<string[]> {
    if (branchNames.length === 0) return []
    if (!repoLocalPath) {
      return branchNames.map((branchName) => `branch ${branchName}: missing repo local path in config`)
    }
    if (dryRun) return []

    const warnings: string[] = []
    for (const branchName of branchNames) {
      try {
        const exists = await branchExistsLocally(repoLocalPath, branchName)
        if (exists) {
          await runGit(['branch', '-D', branchName], { cwd: repoLocalPath })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`branch ${branchName}: ${message}`)
      }

      try {
        const result = await runGit(
          ['push', 'origin', '--delete', branchName],
          { cwd: repoLocalPath, reject: false },
        )
        if (result.exitCode !== 0) {
          const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
          // Treat already-missing refs as a no-op; any other failure is surfaced.
          if (!output.includes('remote ref does not exist')) {
            const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
            warnings.push(`branch ${branchName}: remote delete failed: ${detail}`)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`branch ${branchName}: remote delete failed: ${message}`)
      }
    }
    return warnings
  }
}
