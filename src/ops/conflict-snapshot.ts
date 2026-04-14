import { nowUtcIso } from '../utils/time.js'
import { runGit } from '../git/process.js'
import type {
  ConflictResolutionMetadata,
  ConflictSnapshot,
  ConflictSnapshotExcerpt,
  ConflictSnapshotKind,
  ConflictSnapshotSource,
} from './conflict-types.js'
import type { UpdateStrategy } from '../git/worktree.js'

interface BuildConflictSnapshotInput {
  source: ConflictSnapshotSource
  kind: ConflictSnapshotKind
  strategy: UpdateStrategy
  summary: string
  branchName: string
  baseBranch: string
  files?: string[]
  excerpts?: ConflictSnapshotExcerpt[]
  resolution?: ConflictResolutionMetadata
  branchHeadSha?: string | null
  baseHeadSha?: string | null
  capturedAt?: string
}

export function buildConflictSnapshot(
  input: BuildConflictSnapshotInput,
): ConflictSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: input.capturedAt ?? nowUtcIso(),
    source: input.source,
    kind: input.kind,
    strategy: input.strategy,
    summary: input.summary,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    branchHeadSha: input.branchHeadSha ?? null,
    baseHeadSha: input.baseHeadSha ?? null,
    files: input.files ?? [],
    excerpts: input.excerpts ?? [],
    ...(input.resolution ? { resolution: input.resolution } : {}),
  }
}

export async function resolveConflictSnapshotRefs(
  worktreePath: string,
  baseBranch: string,
): Promise<{ branchHeadSha: string | null; baseHeadSha: string | null }> {
  const [branchHeadSha, baseHeadSha] = await Promise.all([
    revParse(worktreePath, 'HEAD'),
    revParse(worktreePath, `origin/${baseBranch}`),
  ])
  return { branchHeadSha, baseHeadSha }
}

async function revParse(cwd: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', ref], { cwd, timeout: 30_000 })
    const sha = stdout.trim()
    return sha.length > 0 ? sha : null
  } catch {
    return null
  }
}
