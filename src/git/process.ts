import { execa } from 'execa'

const GIT_ENV_WHITELIST = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
] as const

export interface GitExecOptions {
  cwd?: string
  timeout?: number
  reject?: boolean
  env?: Record<string, string>
}

export function buildGitEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of GIT_ENV_WHITELIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...overrides }
}

export async function runGit(
  args: string[],
  options: GitExecOptions = {},
) {
  const { env: envOverrides = {}, ...rest } = options
  return execa('git', args, {
    ...rest,
    extendEnv: false,
    env: buildGitEnv(envOverrides),
  })
}
