import type { RepoConfig } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { FileLoopSession } from './types.js'
import type { VerifyResult } from '../workers/types.js'
import { pushBranch } from '../publishing/push.js'
import { buildFileLoopPrBody, buildFileLoopPrTitle } from './pr-body.js'
import { topLoopEntries } from './loop-md.js'
import { logger } from '../utils/logger.js'

export interface PublishFileLoopResult {
  prNumber: number
  verifyPassed: boolean
}

export async function publishFileLoopSession(args: {
  forge: ForgeAdapter
  repoConfig: RepoConfig
  session: FileLoopSession
  loopMdPath: string
  verifyResults: VerifyResult[]
  verifyPassed: boolean
  onFailure: 'draft-pr' | 'no-pr'
}): Promise<PublishFileLoopResult | null> {
  const deferredNotes = await topLoopEntries(args.session.worktreePath, args.loopMdPath, 5)
  const title = buildFileLoopPrTitle(args.session)
  const body = buildFileLoopPrBody({
    session: args.session,
    verifyResults: args.verifyResults,
    verifyPassed: args.verifyPassed,
    deferredNotes,
  })

  await pushBranch(args.session.worktreePath, args.session.branch, args.repoConfig.updateStrategy)

  if (!args.verifyPassed && args.onFailure === 'no-pr') {
    logger.warn({ repo: args.repoConfig.repo, sessionId: args.session.id }, 'Finalize verification failed and policy is no-pr')
    return null
  }

  const existing = args.session.prNumber
    ? await args.forge.updatePR(args.repoConfig.repo, args.session.prNumber, {
        title,
        body,
        draft: !args.verifyPassed && args.onFailure === 'draft-pr',
      })
    : await args.forge.createPR(args.repoConfig.repo, {
        title,
        body,
        headBranch: args.session.branch,
        baseBranch: args.repoConfig.baseBranch,
        draft: !args.verifyPassed && args.onFailure === 'draft-pr',
      })

  try {
    const labels = ['file-loop']
    if (!args.verifyPassed) labels.push('loop:verify-failed')
    await args.forge.addLabels(args.repoConfig.repo, existing.number, labels)
  } catch (err) {
    logger.warn({ repo: args.repoConfig.repo, prNumber: existing.number, err }, 'Failed to apply file-loop labels')
  }

  return {
    prNumber: existing.number,
    verifyPassed: args.verifyPassed,
  }
}
