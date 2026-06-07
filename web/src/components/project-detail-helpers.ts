import {
  type CommandSpec,
  type ProjectRepoSummary,
  type ProjectsSnapshot,
  type ProjectWorkerProfileSummary,
  type VerifyCommandSummary,
} from '../types/dashboard.js'

type RoleKey = 'planner' | 'coder' | 'reviewer'

export interface RepoAuthDisplay {
  tokenEnv: string
  apiBaseUrl: string
  apiMissing: boolean
}

export function resolveRepoAuthDisplay(repo: ProjectRepoSummary, snapshot: ProjectsSnapshot | null): RepoAuthDisplay {
  if (repo.forge === 'forgejo') {
    return {
      tokenEnv: repo.tokenEnv ?? 'FORGEJO_TOKEN (default)',
      apiBaseUrl: repo.apiBaseUrl ?? '(missing: required for forgejo)',
      apiMissing: !repo.apiBaseUrl,
    }
  }

  return {
    tokenEnv: repo.tokenEnv ?? `${snapshot?.githubDefaults.tokenEnv ?? 'GITHUB_TOKEN'} (global github.tokenEnv)`,
    apiBaseUrl: repo.apiBaseUrl ?? `${snapshot?.githubDefaults.apiBaseUrl ?? 'https://api.github.com'} (global github.apiBaseUrl)`,
    apiMissing: false,
  }
}

export function describeRoleSelection(
  repo: ProjectRepoSummary,
  role: RoleKey,
  workerProfiles: Record<string, ProjectWorkerProfileSummary>,
): string {
  const agent = repo.defaults[role]
  const profileName = repo.agents[agent]
  const mappedProfile = profileName ? workerProfiles[profileName] : undefined
  const fallbackProfile = Object.values(workerProfiles).find((profile) => profile.type === agent)
  const profile = mappedProfile ?? fallbackProfile

  if (!profile) {
    return `${agent} (no worker profile found)`
  }

  const profileLabel = profileName ? profileName : `type:${profile.type}`
  return `${agent} -> ${profileLabel} (${formatWorkerCommand(profile)})`
}

function formatWorkerCommand(profile: ProjectWorkerProfileSummary): string {
  const args = profile.args.map(formatShellArg).join(' ')
  return args ? `${profile.command} ${args}` : profile.command
}

export function collectTags(repo: ProjectRepoSummary): string[] {
  const tags = new Set<string>()

  for (const readyLabel of repo.labels.ready) tags.add(readyLabel)
  tags.add(repo.labels.running)
  tags.add(repo.labels.blocked)
  tags.add(repo.labels.needsHuman)
  tags.add(repo.labels.reviewReady)
  tags.add(repo.labels.error)
  tags.add(repo.labels.retry)
  tags.add(repo.labels.planning)
  tags.add(repo.labels.mergeQueued)
  tags.add(repo.labels.merging)
  tags.add(repo.labels.mergeFailed)

  for (const selector of repo.selectors.includeLabelsAny) tags.add(selector)
  for (const selector of repo.selectors.excludeLabelsAny) tags.add(selector)

  return [...tags]
}

export function formatCommands(commands: VerifyCommandSummary[]): string {
  if (commands.length === 0) return '(none)'
  return commands
    .map((command, index) => {
      if (Array.isArray(command) || typeof command === 'string') {
        return `${index + 1}:${formatCommand(command)}`
      }
      const extras: string[] = []
      if (command.timeoutSeconds !== undefined) extras.push(`timeout=${command.timeoutSeconds}s`)
      if (command.before && command.before.length > 0) extras.push(`before×${command.before.length}`)
      if (command.after && command.after.length > 0) extras.push(`after×${command.after.length}`)
      if (command.envKeys && command.envKeys.length > 0) extras.push(`env×${command.envKeys.length}`)
      const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : ''
      return `${index + 1}:${formatCommand(command.command)}${suffix}`
    })
    .join(' | ')
}

function formatCommand(command: CommandSpec): string {
  if (typeof command === 'string') return command
  return command.map(formatShellArg).join(' ')
}

function formatRunHook(hook: NonNullable<ProjectRepoSummary['environment']>['beforeRun'][number]): string {
  return Array.isArray(hook) || typeof hook === 'string' ? formatCommand(hook) : formatCommand(hook.command)
}

export function formatPorts(repo: ProjectRepoSummary): string {
  const ports = repo.environment?.ports
  const entries = ports ? Object.entries(ports) : []
  if (entries.length === 0) return '(none)'
  return entries.map(([name, range]) => `${name} ${range.min}-${range.max}`).join(', ')
}

export function formatBeforeRun(repo: ProjectRepoSummary): string {
  const hooks = repo.environment?.beforeRun ?? []
  if (hooks.length === 0) return '(none)'
  return hooks.map(formatRunHook).join(' | ')
}

export function formatAfterRun(repo: ProjectRepoSummary): string {
  const hooks = repo.environment?.afterRun ?? []
  if (hooks.length === 0) return '(none)'
  return hooks.map(formatRunHook).join(' | ')
}

export function formatLabelPresentation(repo: ProjectRepoSummary): string {
  const entries = Object.entries(repo.labelConfig)
  if (entries.length === 0) return '(none)'

  return entries
    .map(([label, config]) => {
      const bits: string[] = []
      if (config.color) bits.push(`color:${config.color}`)
      if (config.description) bits.push(`desc:${config.description}`)
      return `${label}[${bits.join(',')}]`
    })
    .join(' | ')
}

export function formatList(values: string[]): string {
  if (values.length === 0) return '(none)'
  return values.join(', ')
}

export function flag(value: boolean): string {
  return value ? 'custom' : 'default'
}

function formatShellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value)
}
