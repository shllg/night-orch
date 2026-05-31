import { describe, expect, it, vi } from 'vitest'
import { processRepoReactions } from '../../src/poller/reaction-processor.js'
import type { Config } from '../../src/config/schema.js'
import type { ForgeAdapter } from '../../src/forge/types.js'
import type { LeaseManager } from '../../src/state/leases.js'
import type { RunManager } from '../../src/state/runs.js'
import type { OrchestrationCache } from '../../src/runner/orchestration-cache.js'

const mockScanAndHandleReactions = vi.fn()
const mockProcessMergeQueue = vi.fn()
const mockScanCostBlockedRuns = vi.fn()
const mockProcessCommentCommands = vi.fn()

vi.mock('../../src/runner/reaction-scan.js', () => ({
  scanAndHandleReactions: (...args: unknown[]) => mockScanAndHandleReactions(...args),
}))

vi.mock('../../src/merge-queue/runner.js', () => ({
  processMergeQueue: (...args: unknown[]) => mockProcessMergeQueue(...args),
}))

vi.mock('../../src/ops/cost-resume.js', () => ({
  scanCostBlockedRuns: (...args: unknown[]) => mockScanCostBlockedRuns(...args),
}))

vi.mock('../../src/runner/comment-commands.js', () => ({
  processCommentCommands: (...args: unknown[]) => mockProcessCommentCommands(...args),
}))

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn() },
}))

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeConfig(): Config {
  return {
    loop: { maxAttemptChainLength: 3 },
    repos: [{ repo: 'org/repo' }],
  } as Config
}

describe('processRepoReactions', () => {
  it('starts independent pre-discovery tasks without waiting for earlier tasks to finish', async () => {
    vi.clearAllMocks()
    const reactionScan = deferred()
    const mergeQueue = deferred()
    const costResume = deferred()
    const commentCommands = deferred()

    mockScanAndHandleReactions.mockReturnValue(reactionScan.promise)
    mockProcessMergeQueue.mockReturnValue(mergeQueue.promise)
    mockScanCostBlockedRuns.mockReturnValue(costResume.promise)
    mockProcessCommentCommands.mockReturnValue(commentCommands.promise)

    const processing = processRepoReactions({
      config: makeConfig(),
      db: {} as never,
      forge: {} as ForgeAdapter,
      repoConfig: { repo: 'org/repo' } as Config['repos'][number],
      runManager: {} as RunManager,
      leaseManager: {} as LeaseManager,
      botUser: 'night-orch',
      cache: { missingCommentCommandIssues: new Map(), reactionCursors: new Map() } as unknown as OrchestrationCache,
    })

    await Promise.resolve()

    expect(mockScanAndHandleReactions).toHaveBeenCalledTimes(1)
    expect(mockProcessMergeQueue).toHaveBeenCalledTimes(1)
    expect(mockScanCostBlockedRuns).toHaveBeenCalledTimes(1)
    expect(mockProcessCommentCommands).toHaveBeenCalledTimes(1)

    reactionScan.reject(new Error('scan failed'))
    mergeQueue.resolve()
    costResume.resolve()
    commentCommands.resolve()

    await expect(processing).resolves.toBeUndefined()
  })
})
