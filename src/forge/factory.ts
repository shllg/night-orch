import type { Config, RepoConfig } from '../config/schema.js'
import type { ForgeAdapter } from './types.js'
import { GitHubForgeAdapter } from './github.js'

export function createForgeAdapter(repoConfig: RepoConfig, globalConfig: Config): ForgeAdapter {
  const forgeType = repoConfig.forge

  switch (forgeType) {
    case 'github': {
      const tokenEnv = globalConfig.github.tokenEnv
      const token = process.env[tokenEnv]
      if (!token) {
        throw new Error(`Environment variable ${tokenEnv} is not set (required for GitHub adapter)`)
      }
      const apiBaseUrl = repoConfig.apiBaseUrl ?? globalConfig.github.apiBaseUrl
      return new GitHubForgeAdapter(token, apiBaseUrl)
    }
    case 'forgejo':
      throw new Error('Forgejo adapter not yet implemented (Phase 11)')
    default:
      throw new Error(`Unknown forge type: ${forgeType as string}`)
  }
}
