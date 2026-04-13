import { FileLoopEngine } from '../../fileloop/engine.js'
import { requestExternalPollCycle } from '../../poller/control.js'
import type { MCPDependencies } from '../server.js'
import { assertMcpMutationAuth } from './auth.js'

export async function handleFileLoop(
  args: {
    action: 'start' | 'stop' | 'status'
    repo?: string
    maxMinutes?: number
    authToken?: string
  },
  deps: MCPDependencies,
): Promise<unknown> {
  const repoConfig = resolveRepoConfig(deps, args.repo)
  const engine = new FileLoopEngine(deps.db, deps.config)

  switch (args.action) {
    case 'start': {
      assertMcpMutationAuth(args.authToken, deps)
      const session = engine.startSession(repoConfig, { maxMinutes: args.maxMinutes })
      const trigger = deps.poller
        ? deps.poller.triggerPollCycle()
        : requestExternalPollCycle(deps.config.storage.dbPath)
      return {
        success: true,
        session,
        pollTrigger: trigger,
      }
    }
    case 'stop': {
      assertMcpMutationAuth(args.authToken, deps)
      const session = engine.stopSession(repoConfig.repo)
      const trigger = deps.poller
        ? deps.poller.triggerPollCycle()
        : requestExternalPollCycle(deps.config.storage.dbPath)
      return {
        success: true,
        session,
        pollTrigger: trigger,
      }
    }
    case 'status':
      return {
        success: true,
        sessions: args.repo ? engine.listSessions(repoConfig.repo, 5) : engine.listSessions(undefined, 20),
      }
  }
}

function resolveRepoConfig(
  deps: MCPDependencies,
  repo: string | undefined,
) {
  if (repo) {
    const match = deps.config.repos.find((candidate) => candidate.repo === repo)
    if (!match) throw new Error(`Repository not found in config: ${repo}`)
    return match
  }

  if (deps.config.repos.length === 1) {
    return deps.config.repos[0]!
  }

  throw new Error('Multiple repositories are configured. Pass repo explicitly.')
}
