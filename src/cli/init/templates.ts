import { stringify } from 'yaml'

export interface InitConfig {
  tokenEnv: string
  repo: string
  localPath: string
  baseBranch: string
  verifyCommands: string[]
  workerType: 'claude' | 'codex' | 'acp'
}

export function generateConfigYaml(params: InitConfig): string {
  const config = {
    version: 1,
    github: {
      tokenEnv: params.tokenEnv,
    },
    workerProfiles: {
      default: {
        type: params.workerType,
        command: params.workerType === 'acp' ? 'claude' : params.workerType,
        args: params.workerType === 'claude' ? ['-p'] : [],
      },
    },
    repos: [
      {
        repo: params.repo,
        localPath: params.localPath,
        baseBranch: params.baseBranch,
        verify: params.verifyCommands,
        agents: {
          claude: 'default',
          codex: 'default',
        },
      },
    ],
  }

  return stringify(config)
}
