import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoConfig, Config, WorkerProfile, FileLoopConfig } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import { createForgeAdapter } from '../forge/factory.js'
import { createWorktreeManager, type WorktreeManager } from '../git/worktree.js'
import { runGit } from '../git/process.js'
import { createWorkerAdapter } from '../workers/factory.js'
import { buildWorkerEnv } from '../workers/env.js'
import { estimateWorkerCost } from '../loop/pricing.js'
import { slugify } from '../utils/ids.js'
import { logger } from '../utils/logger.js'
import { nowUtcIso, parseUtcTimestampMs, utcIsoFromMs } from '../utils/time.js'
import { FileLoopSessionStore } from './session.js'
import { FileLoopFileStateStore } from './file-state.js'
import { resolveFileLoopConfig } from './config.js'
import { pickNext } from './picker.js'
import { appendLoopNote, tailLoopMd } from './loop-md.js'
import { buildFileReviewPrompt } from '../workers/prompt/file-review.js'
import { parseFileReviewOutput } from '../workers/parsers/file-review.js'
import { publishFileLoopSession } from './publish.js'
import { verifyAll, verifyFile } from './verify.js'
import type { FileLoopSession, TickResult, FileReviewEdit } from './types.js'
import type Database from 'better-sqlite3'

export interface StartFileLoopOptions {
  maxMinutes?: number
  nowMs?: number
}

export interface TickRepoResult {
  session: FileLoopSession
  tickResult: TickResult | null
}

export class FileLoopEngine {
  private readonly sessions: FileLoopSessionStore
  private readonly fileStates: FileLoopFileStateStore
  private readonly worktreeManager: WorktreeManager

  constructor(
    private readonly db: Database.Database,
    private readonly config: Config,
    worktreeManager: WorktreeManager = createWorktreeManager(),
  ) {
    this.sessions = new FileLoopSessionStore(db)
    this.fileStates = new FileLoopFileStateStore(db)
    this.worktreeManager = worktreeManager
  }

  startSession(repoConfig: RepoConfig, options: StartFileLoopOptions = {}): FileLoopSession {
    const effective = resolveFileLoopConfig(this.config, repoConfig)
    if (!effective.enabled) {
      throw new Error(`fileLoop is disabled for ${repoConfig.repo}`)
    }

    const existing = this.sessions.getActive(repoConfig.repo)
    if (existing) {
      throw new Error(`File-loop session already active for ${repoConfig.repo}`)
    }

    const nowMs = options.nowMs ?? Date.now()
    const startedAt = utcIsoFromMs(nowMs)
    const endsAt = utcIsoFromMs(nowMs + (options.maxMinutes ?? effective.maxDurationMinutes) * 60_000)
    const branch = buildBranchName(repoConfig.repo, effective.branchNameTemplate, startedAt)
    const worktreePath = buildWorktreePath(this.config.storage.worktreeRoot, repoConfig.repo)

    return this.sessions.create({
      repo: repoConfig.repo,
      branch,
      worktreePath,
      startedAt,
      endsAt,
      status: 'armed',
    })
  }

  getActiveSession(repo: string): FileLoopSession | null {
    return this.sessions.getActive(repo)
  }

  listSessions(repo?: string, limit = 20): FileLoopSession[] {
    return this.sessions.listRecent(repo, limit)
  }

  stopSession(repo: string, reason: 'manual' | 'budget' | 'error' = 'manual'): FileLoopSession {
    const session = this.sessions.getActive(repo)
    if (!session) {
      throw new Error(`No active file-loop session for ${repo}`)
    }
    this.sessions.requestFinalize(session.id, reason)
    return this.sessions.getById(session.id) ?? session
  }

  async tickRepo(
    repoConfig: RepoConfig,
    forge: ForgeAdapter = createForgeAdapter(repoConfig, this.config),
    nowMs = Date.now(),
  ): Promise<TickRepoResult | null> {
    const session = this.sessions.getActive(repoConfig.repo)
    if (!session) return null

    const effective = resolveFileLoopConfig(this.config, repoConfig)
    const expired = nowMs >= parseUtcTimestampMs(session.endsAt)
    if (expired) {
      const finalized = await this.finalize(session, repoConfig, forge, 'timer')
      return { session: finalized, tickResult: null }
    }

    if (session.status === 'finalizing') {
      const finalized = await this.finalize(session, repoConfig, forge, session.stoppedReason ?? 'manual')
      return { session: finalized, tickResult: null }
    }

    const activeRuns = this.countActiveIssueRuns(repoConfig.repo)
    if (activeRuns > 0) {
      if (session.status !== 'paused') {
        this.sessions.pause(session.id)
      }
      const paused = this.sessions.getById(session.id) ?? session
      return { session: paused, tickResult: null }
    }

    if (session.status === 'armed' || session.status === 'paused') {
      this.sessions.resume(session.id)
    }

    if (session.totalCostUsd >= effective.maxCostUsd) {
      this.sessions.requestFinalize(session.id, 'budget')
      const updated = this.sessions.getById(session.id) ?? session
      return { session: updated, tickResult: null }
    }

    const active = this.sessions.getById(session.id) ?? session
    const tickResult = await this.tickOnce(active, repoConfig)
    const updated = this.sessions.getById(session.id) ?? active
    return { session: updated, tickResult }
  }

  async tickOnce(session: FileLoopSession, repoConfig: RepoConfig): Promise<TickResult> {
    const effective = resolveFileLoopConfig(this.config, repoConfig)
    const profile = resolveReviewerProfile(this.config, effective)
    const adapter = createWorkerAdapter(profile)
    const ensured = await this.worktreeManager.ensure({
      repoLocalPath: repoConfig.localPath,
      baseBranch: repoConfig.baseBranch,
      branchName: session.branch,
      worktreePath: session.worktreePath,
      preserveBranchState: true,
      updateStrategy: repoConfig.updateStrategy,
    })

    if (ensured.rebaseConflict) {
      this.sessions.markFailed(session.id, 'error')
      return { kind: 'error', filePath: null, summary: 'Worktree update conflict prevented file-loop progress', costUsd: 0 }
    }

    const candidate = await pickNext(repoConfig.repo, ensured.path, effective, this.fileStates)
    if (!candidate) {
      this.sessions.requestFinalize(session.id, 'exhausted')
      this.sessions.update(session.id, {
        iterations: session.iterations + 1,
        lastFileIterAt: nowUtcIso(),
      })
      return { kind: 'exhausted', summary: 'No eligible files remain for this file-loop session' }
    }

    const fileAbsolutePath = join(ensured.path, candidate.filePath)
    const source = await readFile(fileAbsolutePath, 'utf8')
    const prompt = buildFileReviewPrompt({
      filePath: candidate.filePath,
      contents: source,
      tailLoopMd: await tailLoopMd(ensured.path, effective.loopMdPath),
    })
    const worker = await adapter.runTask({
      role: 'reviewer',
      worktreePath: ensured.path,
      prompt: `${prompt.systemPrompt}\n\n${prompt.userPrompt}`,
      profile,
      timeoutSeconds: effective.perIterationTimeoutSeconds,
      env: buildWorkerEnv(profile),
    })

    const cost = estimateWorkerCost({
      cost: this.config.cost,
      identity: {
        role: 'reviewer',
        workerType: profile.type,
        pricingModel: profile.pricingModel ?? null,
        fallbackMinuteUsd: profile.minuteUsd ?? null,
      },
      durationMs: worker.durationMs,
      tokenUsage: worker.tokenUsage,
      costModel: this.config.cost.model,
    }).usd

    const parseResult = parseFileReviewOutput(worker.rawOutput, candidate.filePath)
    const iterAt = nowUtcIso()

    if (!parseResult.result) {
      this.fileStates.upsert({
        repo: repoConfig.repo,
        filePath: candidate.filePath,
        lastTouchedAt: iterAt,
        lastStatus: 'error',
        lastSummaryShort: parseResult.error,
      })
      this.bumpSession(session, cost, iterAt)
      return { kind: 'error', filePath: candidate.filePath, summary: parseResult.error ?? 'Unparseable file review output', costUsd: cost, worker }
    }

    const parsed = parseResult.result
    const loopCommitCreated = await this.recordDeferredNoteIfNeeded(ensured.path, effective, candidate.filePath, parsed.refactorNotes)
    if (loopCommitCreated) {
      await commitFile(ensured.path, effective.loopMdPath, `${effective.commitPrefix} loop.md: ${candidate.filePath}`)
    }

    if (parsed.difficulty !== 'trivial') {
      this.fileStates.upsert({
        repo: repoConfig.repo,
        filePath: candidate.filePath,
        lastTouchedAt: iterAt,
        lastStatus: 'deferred',
        lastSummaryShort: parsed.summary,
        lastDifficultyFlag: parsed.difficulty,
      })
      this.bumpSession(session, cost, iterAt)
      return {
        kind: 'deferred',
        filePath: candidate.filePath,
        summary: parsed.summary,
        costUsd: cost,
        difficulty: parsed.difficulty,
        worker,
      }
    }

    if (parsed.trivialFixes.length === 0) {
      this.fileStates.upsert({
        repo: repoConfig.repo,
        filePath: candidate.filePath,
        lastTouchedAt: iterAt,
        lastStatus: 'noop',
        lastSummaryShort: parsed.summary,
        lastDifficultyFlag: parsed.difficulty,
      })
      this.bumpSession(session, cost, iterAt)
      return { kind: 'noop', filePath: candidate.filePath, summary: parsed.summary, costUsd: cost, worker }
    }

    await applyEdits(fileAbsolutePath, source, parsed.trivialFixes)
    const verification = await verifyFile(ensured.path, candidate.filePath, effective)
    if (!verification.passed) {
      await runGit(['checkout', '--', candidate.filePath], { cwd: ensured.path })
      this.fileStates.upsert({
        repo: repoConfig.repo,
        filePath: candidate.filePath,
        lastTouchedAt: iterAt,
        lastStatus: 'error',
        lastSummaryShort: parsed.summary,
        lastDifficultyFlag: parsed.difficulty,
      })
      this.bumpSession(session, cost, iterAt)
      return { kind: 'error', filePath: candidate.filePath, summary: parsed.summary, costUsd: cost, worker }
    }

    await commitFile(ensured.path, candidate.filePath, `${effective.commitPrefix} ${candidate.filePath}: ${truncateSummary(parsed.summary)}`)
    this.fileStates.upsert({
      repo: repoConfig.repo,
      filePath: candidate.filePath,
      lastTouchedAt: iterAt,
      lastStatus: 'edited',
      lastSummaryShort: parsed.summary,
      lastDifficultyFlag: parsed.difficulty,
      incrementTouchCount: true,
    })
    this.bumpSession(session, cost, iterAt, true)
    const current = this.sessions.getById(session.id)
    if ((current?.totalCostUsd ?? 0) >= effective.maxCostUsd) {
      this.sessions.requestFinalize(session.id, 'budget')
    }
    return { kind: 'edited', filePath: candidate.filePath, summary: parsed.summary, costUsd: cost, worker }
  }

  async finalize(
    session: FileLoopSession,
    repoConfig: RepoConfig,
    forge: ForgeAdapter = createForgeAdapter(repoConfig, this.config),
    reason: 'timer' | 'manual' | 'budget' | 'error' | 'exhausted' = 'manual',
  ): Promise<FileLoopSession> {
    const effective = resolveFileLoopConfig(this.config, repoConfig)
    const ensured = await this.worktreeManager.ensure({
      repoLocalPath: repoConfig.localPath,
      baseBranch: repoConfig.baseBranch,
      branchName: session.branch,
      worktreePath: session.worktreePath,
      preserveBranchState: true,
      updateStrategy: repoConfig.updateStrategy,
    })

    const commitCount = await countCommitsAhead(ensured.path, repoConfig.baseBranch)
    if (commitCount === 0) {
      this.sessions.markDone(session.id, reason, null)
      await safeRemoveWorktree(this.worktreeManager, ensured.path)
      return this.sessions.getById(session.id) ?? session
    }

    const verification = await verifyAll(ensured.path, effective)
    const published = await publishFileLoopSession({
      forge,
      repoConfig,
      session: this.sessions.getById(session.id) ?? session,
      loopMdPath: effective.loopMdPath,
      verifyResults: verification.results,
      verifyPassed: verification.passed,
      onFailure: effective.finalizeVerify.onFailure,
    })

    if (!published && !verification.passed && effective.finalizeVerify.onFailure === 'no-pr') {
      this.sessions.markFailed(session.id, 'error')
      await safeRemoveWorktree(this.worktreeManager, ensured.path)
      return this.sessions.getById(session.id) ?? session
    }

    this.sessions.markDone(session.id, reason, published?.prNumber ?? null)
    await safeRemoveWorktree(this.worktreeManager, ensured.path)
    return this.sessions.getById(session.id) ?? session
  }

  private countActiveIssueRuns(repo: string): number {
    const row = this.db
      .prepare(
        `WITH ranked_runs AS (
           SELECT
             r.repo,
             r.issue_number,
             r.status,
             ROW_NUMBER() OVER (
               PARTITION BY r.repo, r.issue_number
               ORDER BY
                 COALESCE(julianday(r.created_at), 0) DESC,
                 COALESCE(julianday(r.updated_at), 0) DESC,
                 r.rowid DESC,
                 r.id DESC
             ) AS run_rank
           FROM runs r
           WHERE r.repo = ?
         )
         SELECT COUNT(*) AS count
         FROM ranked_runs
         WHERE run_rank = 1
           AND status IN ('queued', 'running', 'blocked', 'review_ready', 'error')`,
      )
      .get(repo) as { count: number }
    return row.count
  }

  private bumpSession(session: FileLoopSession, costUsd: number, iterAt: string, touchedFile = false): void {
    this.sessions.update(session.id, {
      status: 'running',
      iterations: session.iterations + 1,
      lastFileIterAt: iterAt,
      totalCostUsd: Number((session.totalCostUsd + costUsd).toFixed(6)),
      filesTouched: session.filesTouched + (touchedFile ? 1 : 0),
    })
  }

  private async recordDeferredNoteIfNeeded(
    worktreePath: string,
    effective: FileLoopConfig,
    filePath: string,
    refactorNotes: string | null,
  ): Promise<boolean> {
    if (!refactorNotes || refactorNotes.trim().length === 0) return false

    await appendLoopNote(worktreePath, effective.loopMdPath, filePath, refactorNotes)
    const { stdout } = await runGit(['status', '--porcelain', '--', effective.loopMdPath], { cwd: worktreePath })
    return stdout.trim().length > 0
  }
}

function resolveReviewerProfile(config: Config, effective: FileLoopConfig): WorkerProfile {
  const byName = config.workerProfiles[effective.reviewerProfileKey]
  if (byName) return byName

  const byType = Object.values(config.workerProfiles).find((profile) => profile.type === effective.reviewerProfileKey)
  if (byType) return byType

  throw new Error(`No worker profile found for fileLoop.reviewerProfileKey "${effective.reviewerProfileKey}"`)
}

function buildBranchName(repo: string, template: string, startedAt: string): string {
  const repoSlug = slugify(repo.replace('/', '-'), 50) || 'repo'
  const yyyyMmDd = startedAt.slice(0, 10).replace(/-/g, '')
  return template
    .replaceAll('{repoSlug}', repoSlug)
    .replaceAll('{yyyyMmDd}', yyyyMmDd)
}

function buildWorktreePath(worktreeRoot: string, repo: string): string {
  return join(worktreeRoot, repo.replace('/', '__'), 'file-loop')
}

async function applyEdits(filePath: string, original: string, edits: FileReviewEdit[]): Promise<void> {
  let next = original
  for (const edit of edits) {
    if (edit.search.length === 0) {
      throw new Error('File-loop edits must not use an empty search string')
    }
    if (!next.includes(edit.search)) {
      throw new Error(`File-loop search block not found in ${edit.filePath}`)
    }
    next = next.replace(edit.search, edit.replace)
  }
  await writeFile(filePath, next, 'utf8')
}

async function commitFile(worktreePath: string, filePath: string, message: string): Promise<void> {
  await runGit(['add', '--', filePath], { cwd: worktreePath })
  const { stdout } = await runGit(['diff', '--cached', '--name-only', '--', filePath], { cwd: worktreePath })
  if (stdout.trim().length === 0) return
  await runGit(['commit', '-m', message], { cwd: worktreePath })
}

async function countCommitsAhead(worktreePath: string, baseBranch: string): Promise<number> {
  const { stdout } = await runGit(['rev-list', '--count', `origin/${baseBranch}..HEAD`], { cwd: worktreePath })
  const count = Number.parseInt(stdout.trim(), 10)
  return Number.isNaN(count) ? 0 : count
}

async function safeRemoveWorktree(worktreeManager: WorktreeManager, worktreePath: string): Promise<void> {
  try {
    await worktreeManager.remove(worktreePath, true)
  } catch (err) {
    logger.warn({ worktreePath, err }, 'Failed to remove file-loop worktree after finalize')
  }
}

function truncateSummary(summary: string): string {
  const trimmed = summary.replace(/\s+/g, ' ').trim()
  return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69)}...`
}
