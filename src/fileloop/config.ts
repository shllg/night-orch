import type { Config, FileLoopConfig, RepoConfig } from '../config/schema.js'

export function resolveFileLoopConfig(config: Config, repoConfig: RepoConfig): FileLoopConfig {
  return {
    ...config.fileLoop,
    ...repoConfig.fileLoop,
    perEditVerify: {
      ...config.fileLoop.perEditVerify,
      ...(repoConfig.fileLoop.perEditVerify ?? {}),
    },
    finalizeVerify: {
      ...config.fileLoop.finalizeVerify,
      ...(repoConfig.fileLoop.finalizeVerify ?? {}),
    },
  }
}
