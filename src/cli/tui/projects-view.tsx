import React from 'react'
import { Box, Text } from 'ink'
import type { RepoConfig, WorkerProfile } from '../../config/schema.js'
import { truncate } from './format.js'
import type { ProjectsViewMode } from './types.js'

interface ProjectsViewProps {
  repos: RepoConfig[]
  selectedIndex: number
  workerProfiles: Record<string, WorkerProfile>
  globalGithubTokenEnv: string
  globalGithubApiBaseUrl: string
  mode: ProjectsViewMode
}

type CommandSpec = string | string[]
type VerifyCommandSpec = RepoConfig['verify'][number]
type RoleKey = 'planner' | 'coder' | 'reviewer'
type RepoAuthDefaults = {
  githubTokenEnv: string
  githubApiBaseUrl: string
}

interface RepoAuthDisplay {
  tokenEnv: string
  apiBaseUrl: string
  apiMissing: boolean
}

export function ProjectsView({
  repos,
  selectedIndex,
  workerProfiles,
  globalGithubTokenEnv,
  globalGithubApiBaseUrl,
  mode,
}: ProjectsViewProps): React.ReactElement {
  const safeIndex = resolveProjectSelectionIndex(selectedIndex, repos.length)
  const selectedRepo = safeIndex >= 0 ? (repos[safeIndex] ?? null) : null
  const authDefaults: RepoAuthDefaults = {
    githubTokenEnv: globalGithubTokenEnv,
    githubApiBaseUrl: globalGithubApiBaseUrl,
  }
  const authDisplay = selectedRepo ? resolveRepoAuthDisplay(selectedRepo, authDefaults) : null

  if (mode === 'focus') {
    return (
      <FocusedProjectView
        selectedRepo={selectedRepo}
        workerProfiles={workerProfiles}
        authDisplay={authDisplay}
      />
    )
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Box width="38%" flexDirection="column" marginRight={1}>
          <Text bold>Projects ({repos.length})</Text>
          {repos.length === 0 && <Text color="gray">  No configured repositories</Text>}
          {repos.map((repo, index) => {
            const selected = index === safeIndex
            return (
              <Box key={repo.repo} flexDirection="column">
                <Text>
                  <Text color={selected ? 'cyan' : 'gray'}>{selected ? '▶' : ' '}</Text>
                  {' '}
                  <Text color="gray">{String(index + 1).padStart(2, '0')}</Text>
                  {' '}
                  <Text>{repo.repo}</Text>
                  {' '}
                  <Text color="gray">({repo.forge})</Text>
                </Text>
                <Text dimColor>
                  {'   '}
                  <Text>base {repo.baseBranch}</Text>
                  {'  '}
                  <Text>coder {repo.defaults.coder}</Text>
                  {'  '}
                  <Text>workflow {repo.workflow ?? 'default'}</Text>
                </Text>
              </Box>
            )
          })}
        </Box>

        <Box width="62%" flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="cyan">Project Preview</Text>
          {!selectedRepo && <Text color="gray">Select a repository to inspect</Text>}
          {selectedRepo && (
            <>
              <Text>{selectedRepo.repo}</Text>
              <Text dimColor>path {truncate(selectedRepo.localPath, 92)}</Text>
              <Text>
                forge {selectedRepo.forge}
                {'  '}
                base {selectedRepo.baseBranch}
                {'  '}
                workflow {selectedRepo.workflow ?? 'default'}
              </Text>
              <Text>
                concurrency {selectedRepo.maxConcurrentRuns}
                {'  '}
                coder {selectedRepo.defaults.coder}
              </Text>
              <Text dimColor>
                labels {selectedRepo.labels.ready.join(', ')}
                {'  '}
                {'->'} {selectedRepo.labels.reviewReady}
              </Text>
            </>
          )}
        </Box>
      </Box>
      <Text color="gray">Press j/k to select a project, then o or Enter for full details</Text>
    </Box>
  )
}

interface FocusedProjectViewProps {
  selectedRepo: RepoConfig | null
  workerProfiles: Record<string, WorkerProfile>
  authDisplay: RepoAuthDisplay | null
}

function FocusedProjectView({
  selectedRepo,
  workerProfiles,
  authDisplay,
}: FocusedProjectViewProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Project Detail</Text>
      {!selectedRepo && <Text color="gray">No project selected</Text>}
      {selectedRepo && authDisplay && (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="cyan">{selectedRepo.repo}</Text>
          <Text dimColor>path {truncate(selectedRepo.localPath, 120)}</Text>
          <Text>
            forge {selectedRepo.forge}
            {'  '}
            branch {selectedRepo.baseBranch}
            {'  '}
            prefix {selectedRepo.branchPrefix}
            {'  '}
            workflow {selectedRepo.workflow ?? 'default'}
          </Text>
          <Text>
            concurrency {selectedRepo.maxConcurrentRuns}
            {'  '}
            token {authDisplay.tokenEnv}
            {'  '}
            api {authDisplay.apiBaseUrl}
          </Text>
          {authDisplay.apiMissing && (
            <Text color="yellow">apiBaseUrl is required for Forgejo repositories</Text>
          )}

          <Text bold>Tools</Text>
          <Text>planner {describeRoleSelection(selectedRepo, 'planner', workerProfiles)}</Text>
          <Text>coder   {describeRoleSelection(selectedRepo, 'coder', workerProfiles)}</Text>
          <Text>reviewer {describeRoleSelection(selectedRepo, 'reviewer', workerProfiles)}</Text>
          <Text>mentions {formatList(selectedRepo.defaults.prMentions)}</Text>

          <Text bold>Tags & Lanes</Text>
          <Text>all tags {formatList(collectTags(selectedRepo))}</Text>
          <Text>include {formatList(selectedRepo.selectors.includeLabelsAny)}</Text>
          <Text>exclude {formatList(selectedRepo.selectors.excludeLabelsAny)}</Text>
          <Text>
            lanes ready:{formatList(selectedRepo.labels.ready)} running:{selectedRepo.labels.running} review:{selectedRepo.labels.reviewReady} blocked:{selectedRepo.labels.blocked}
          </Text>

          <Text bold>Execution</Text>
          <Text>verify {formatCommands(selectedRepo.verify)}</Text>
          <Text>planning PRD dir {selectedRepo.planning.prdDirectory}</Text>
          <Text>
            prompts planner:{flag(selectedRepo.prompts?.plannerSystem)} coder:{flag(selectedRepo.prompts?.coderSystem)} reviewer:{flag(selectedRepo.prompts?.reviewerSystem)}
          </Text>

          <Text bold>Environment</Text>
          <Text>ports {formatPorts(selectedRepo)}</Text>
          <Text>beforeRun {formatRunHooks(selectedRepo.environment?.beforeRun)}</Text>
          <Text>afterRun {formatRunHooks(selectedRepo.environment?.afterRun)}</Text>

          <Text bold>Merge Queue & Labels</Text>
          <Text>
            merge queue {selectedRepo.mergeQueue.enabled ? 'enabled' : 'disabled'}
            {'  '}
            batch {selectedRepo.mergeQueue.batchSize}
            {'  '}
            method {selectedRepo.mergeQueue.mergeMethod}
            {'  '}
            approval {selectedRepo.mergeQueue.requireApproval ? 'required' : 'optional'}
            {'  '}
            retryFlakyOnce {selectedRepo.mergeQueue.retryFlakyOnce ? 'yes' : 'no'}
          </Text>
          <Text>staging branch {selectedRepo.mergeQueue.stagingBranchPrefix}</Text>
          <Text>label presentation {formatLabelPresentation(selectedRepo)}</Text>
        </Box>
      )}
      <Text color="gray">Press q or esc to close project detail</Text>
    </Box>
  )
}

function describeRoleSelection(
  repo: RepoConfig,
  role: RoleKey,
  workerProfiles: Record<string, WorkerProfile>,
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

function formatWorkerCommand(profile: WorkerProfile): string {
  const args = profile.args.map(formatShellArg).join(' ')
  return args ? `${profile.command} ${args}` : profile.command
}

function collectTags(repo: RepoConfig): string[] {
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

function formatCommands(commands: VerifyCommandSpec[]): string {
  if (commands.length === 0) return '(none)'
  return commands
    .map((command, index) => {
      if (Array.isArray(command) || typeof command === 'string') {
        return `${index + 1}:${formatCommand(command)}`
      }
      const parts: string[] = [formatCommand(command.command)]
      if (command.timeoutSeconds !== undefined) parts.push(`timeout=${command.timeoutSeconds}s`)
      if (command.before && command.before.length > 0) parts.push(`before×${command.before.length}`)
      if (command.after && command.after.length > 0) parts.push(`after×${command.after.length}`)
      if (command.env && Object.keys(command.env).length > 0) parts.push(`env×${Object.keys(command.env).length}`)
      const suffix = parts.length > 1 ? ` (${parts.slice(1).join(', ')})` : ''
      return `${index + 1}:${parts[0]}${suffix}`
    })
    .join(' | ')
}

function formatCommand(command: CommandSpec): string {
  if (typeof command === 'string') return command
  return command.map(formatShellArg).join(' ')
}

function formatPorts(repo: RepoConfig): string {
  const ports = repo.environment?.ports
  if (!ports) return '(none)'
  const entries = Object.entries(ports)
  if (entries.length === 0) return '(none)'
  return entries.map(([name, range]) => `${name} ${range.min}-${range.max}`).join(', ')
}

type RunHookList = NonNullable<RepoConfig['environment']>['beforeRun']

function formatRunHooks(hooks: RunHookList | undefined): string {
  if (!hooks || hooks.length === 0) return '(none)'
  return hooks
    .map((hook) => (Array.isArray(hook) || typeof hook === 'string' ? formatCommand(hook) : formatCommand(hook.command)))
    .join(' | ')
}

function formatLabelPresentation(repo: RepoConfig): string {
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

function formatList(values: string[]): string {
  if (values.length === 0) return '(none)'
  return values.join(', ')
}

function flag(value: string | undefined): string {
  return value ? 'custom' : 'default'
}

function formatShellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value)
}

export function resolveProjectSelectionIndex(selectedIndex: number, repoCount: number): number {
  if (repoCount <= 0) return -1
  return Math.max(0, Math.min(repoCount - 1, selectedIndex))
}

export function resolveRepoAuthDisplay(repo: RepoConfig, defaults: RepoAuthDefaults): RepoAuthDisplay {
  if (repo.forge === 'forgejo') {
    const tokenEnv = repo.tokenEnv ?? 'FORGEJO_TOKEN (default)'
    const apiMissing = !repo.apiBaseUrl
    return {
      tokenEnv,
      apiBaseUrl: repo.apiBaseUrl ?? '(missing: required for forgejo)',
      apiMissing,
    }
  }

  return {
    tokenEnv: repo.tokenEnv ?? `${defaults.githubTokenEnv} (global github.tokenEnv)`,
    apiBaseUrl: repo.apiBaseUrl ?? `${defaults.githubApiBaseUrl} (global github.apiBaseUrl)`,
    apiMissing: false,
  }
}
