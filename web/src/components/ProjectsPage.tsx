import { type ReactElement, useMemo } from 'react'

import { formatTimestamp, truncate } from '../lib/format.js'
import {
  type CommandSpec,
  type ProjectRepoSummary,
  type ProjectsSnapshot,
  type ProjectWorkerProfileSummary,
} from '../types/dashboard.js'

interface ProjectsPageProps {
  snapshot: ProjectsSnapshot | null
  isLoading: boolean
  selectedRepo: string
  onSelectedRepoChange: (repo: string) => void
}

type RoleKey = 'planner' | 'coder' | 'reviewer'

interface RepoAuthDisplay {
  tokenEnv: string
  apiBaseUrl: string
  apiMissing: boolean
}

export function ProjectsPage({
  snapshot,
  isLoading,
  selectedRepo,
  onSelectedRepoChange,
}: ProjectsPageProps): ReactElement {
  const repos = snapshot?.repos ?? []
  const workerProfiles = snapshot?.workerProfiles ?? {}
  const selectedProject = useMemo(
    () => repos.find((repo) => repo.repo === selectedRepo) ?? repos[0] ?? null,
    [repos, selectedRepo],
  )
  const authDisplay = selectedProject ? resolveRepoAuthDisplay(selectedProject, snapshot) : null

  if (isLoading && !snapshot) {
    return (
      <section className="grid gap-5 xl:grid-cols-[1.05fr_1.95fr]">
        <div className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <div className="skeleton h-5 w-36" />
            <div className="mt-4 space-y-2">
              <div className="skeleton h-14 w-full" />
              <div className="skeleton h-14 w-full" />
              <div className="skeleton h-14 w-full" />
            </div>
          </div>
        </div>
        <div className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
          <div className="card-body p-4 sm:p-5">
            <div className="skeleton h-5 w-44" />
            <div className="mt-4 grid gap-3">
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-16 w-full" />
            </div>
          </div>
        </div>
      </section>
    )
  }

  if (!snapshot) {
    return (
      <section className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
        <div className="card-body p-6">
          <h2 className="card-title text-2xl font-semibold text-base-content">Projects</h2>
          <div className="alert mt-3 border border-base-300/60 bg-base-100/70 text-sm">
            <span>Project configuration is currently unavailable.</span>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[1.05fr_1.95fr]">
      <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
        <div className="card-body p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="card-title text-lg">Projects ({repos.length})</h2>
            <span className="text-[11px] text-base-content/60">
              Updated {formatTimestamp(snapshot.generatedAt)}
            </span>
          </div>

          {repos.length === 0 ? (
            <div className="alert mt-4 border border-base-300/60 bg-base-100/70 text-sm">
              <span>No repositories are configured.</span>
            </div>
          ) : (
            <div className="mt-4 grid max-h-[680px] gap-2 overflow-y-auto pr-1">
              {repos.map((repo) => {
                const selected = selectedProject?.repo === repo.repo
                return (
                  <button
                    key={repo.repo}
                    type="button"
                    onClick={() => onSelectedRepoChange(repo.repo)}
                    className={`rounded-box border px-3 py-2 text-left transition-colors ${
                      selected
                        ? 'border-info/75 bg-info/12'
                        : 'border-base-300/70 bg-base-100/55 hover:border-info/45 hover:bg-base-100/80'
                    }`}
                  >
                    <p className="text-sm font-semibold text-base-content">{repo.repo}</p>
                    <p className="mt-0.5 text-xs text-base-content/70">
                      {repo.forge}
                      {'  ·  '}
                      base {repo.baseBranch}
                    </p>
                    <p className="mt-0.5 text-xs text-base-content/55">
                      workflow {repo.workflow ?? 'default'}
                      {'  ·  '}
                      coder {repo.defaults.coder}
                    </p>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </article>

      <article className="card border border-base-300/60 bg-base-200/60 shadow-panel backdrop-blur">
        <div className="card-body p-4 sm:p-5">
          <h2 className="card-title text-lg">Project Configuration</h2>
          {!selectedProject && (
            <div className="alert mt-4 border border-base-300/60 bg-base-100/70 text-sm">
              <span>Select a repository to inspect its configuration.</span>
            </div>
          )}

          {selectedProject && authDisplay && (
            <div className="mt-4 space-y-4">
              <section className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
                <h3 className="text-sm font-semibold text-base-content">{selectedProject.repo}</h3>
                <p className="mt-1 text-xs text-base-content/65">
                  path {truncate(selectedProject.localPath, 140)}
                </p>
                <div className="mt-3 grid gap-2 text-xs text-base-content/80 sm:grid-cols-2">
                  <p>forge {selectedProject.forge}</p>
                  <p>base branch {selectedProject.baseBranch}</p>
                  <p>branch prefix {selectedProject.branchPrefix}</p>
                  <p>workflow {selectedProject.workflow ?? 'default'}</p>
                  <p>max concurrency {selectedProject.maxConcurrentRuns}</p>
                  <p>linked projects {formatList(selectedProject.linkedProjects)}</p>
                </div>
              </section>

              <section className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
                    Auth
                  </h3>
                  <p className="mt-2 text-xs text-base-content/85">token {authDisplay.tokenEnv}</p>
                  <p className="mt-1 text-xs text-base-content/85">api {authDisplay.apiBaseUrl}</p>
                  {authDisplay.apiMissing && (
                    <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning">
                      apiBaseUrl is required for Forgejo repositories.
                    </p>
                  )}
                </div>

                <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
                    Tools
                  </h3>
                  <div className="mt-2 space-y-1 text-xs text-base-content/85">
                    <p>planner {describeRoleSelection(selectedProject, 'planner', workerProfiles)}</p>
                    <p>coder {describeRoleSelection(selectedProject, 'coder', workerProfiles)}</p>
                    <p>reviewer {describeRoleSelection(selectedProject, 'reviewer', workerProfiles)}</p>
                    <p>mentions {formatList(selectedProject.defaults.prMentions)}</p>
                  </div>
                </div>

                <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
                    Labels
                  </h3>
                  <div className="mt-2 space-y-1 text-xs text-base-content/85">
                    <p>all tags {formatList(collectTags(selectedProject))}</p>
                    <p>include {formatList(selectedProject.selectors.includeLabelsAny)}</p>
                    <p>exclude {formatList(selectedProject.selectors.excludeLabelsAny)}</p>
                    <p>
                      lanes ready:{formatList(selectedProject.labels.ready)}
                      {'  '}
                      running:{selectedProject.labels.running}
                      {'  '}
                      review:{selectedProject.labels.reviewReady}
                      {'  '}
                      blocked:{selectedProject.labels.blocked}
                    </p>
                    {selectedProject.kanban && (
                      <p>
                        kanban trigger:{selectedProject.kanban.triggerLabel}
                        {'  '}
                        blocked:{selectedProject.kanban.labels.blocked}
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
                    Execution
                  </h3>
                  <div className="mt-2 space-y-1 text-xs text-base-content/85">
                    <p>verify {formatCommands(selectedProject.verify)}</p>
                    <p>planning PRD dir {selectedProject.planning.prdDirectory}</p>
                    <p>
                      prompts planner:{flag(selectedProject.prompts.plannerSystem)}
                      {'  '}
                      coder:{flag(selectedProject.prompts.coderSystem)}
                      {'  '}
                      reviewer:{flag(selectedProject.prompts.reviewerSystem)}
                    </p>
                  </div>
                </div>
              </section>

              <section className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
                    Environment
                  </h3>
                  <div className="mt-2 space-y-1 text-xs text-base-content/85">
                    <p>mode {selectedProject.environment?.defaultMode ?? 'shared (implicit default)'}</p>
                    <p>bootstrap {formatBootstrap(selectedProject)}</p>
                    <p>cleanup {formatCleanup(selectedProject)}</p>
                    <p>shared {formatSharedEnv(selectedProject)}</p>
                    <p>dedicated {formatDedicatedEnv(selectedProject)}</p>
                  </div>
                </div>

                <div className="rounded-box border border-base-300/70 bg-base-100/65 px-3 py-3">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-base-content/65">
                    Merge Queue
                  </h3>
                  <div className="mt-2 space-y-1 text-xs text-base-content/85">
                    <p>
                      merge queue {selectedProject.mergeQueue.enabled ? 'enabled' : 'disabled'}
                      {'  '}
                      batch {selectedProject.mergeQueue.batchSize}
                      {'  '}
                      method {selectedProject.mergeQueue.mergeMethod}
                      {'  '}
                      approval {selectedProject.mergeQueue.requireApproval ? 'required' : 'optional'}
                      {'  '}
                      retryFlakyOnce {selectedProject.mergeQueue.retryFlakyOnce ? 'yes' : 'no'}
                    </p>
                    <p>staging branch {selectedProject.mergeQueue.stagingBranchPrefix}</p>
                    <p>label presentation {formatLabelPresentation(selectedProject)}</p>
                  </div>
                </div>
              </section>

              <details className="collapse collapse-arrow rounded-box border border-base-300/70 bg-base-100/65">
                <summary className="collapse-title py-3 text-sm font-semibold text-base-content">
                  Raw Sanitized Config
                </summary>
                <div className="collapse-content pt-0">
                  <pre className="overflow-x-auto rounded-md border border-base-300/70 bg-base-300/30 p-3 text-[11px] leading-relaxed text-base-content/85">
                    {JSON.stringify(selectedProject, null, 2)}
                  </pre>
                </div>
              </details>
            </div>
          )}
        </div>
      </article>
    </section>
  )
}

function resolveRepoAuthDisplay(repo: ProjectRepoSummary, snapshot: ProjectsSnapshot | null): RepoAuthDisplay {
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

function describeRoleSelection(
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

function collectTags(repo: ProjectRepoSummary): string[] {
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

function formatCommands(commands: CommandSpec[]): string {
  if (commands.length === 0) return '(none)'
  return commands.map((command, index) => `${index + 1}:${formatCommand(command)}`).join(' | ')
}

function formatCommand(command: CommandSpec): string {
  if (typeof command === 'string') return command
  return command.map(formatShellArg).join(' ')
}

function formatBootstrap(repo: ProjectRepoSummary): string {
  const bootstrap = repo.environment?.bootstrap ?? []
  if (bootstrap.length === 0) return '(none)'
  return bootstrap.map((step) => `${step.when}:${formatCommand(step.command)}`).join(' | ')
}

function formatCleanup(repo: ProjectRepoSummary): string {
  const cleanup = repo.environment?.cleanup ?? []
  if (cleanup.length === 0) return '(none)'
  return cleanup.map((step) => `${step.when}:${formatCommand(step.command)}`).join(' | ')
}

function formatSharedEnv(repo: ProjectRepoSummary): string {
  const shared = repo.environment?.shared
  if (!shared) return '(not configured)'
  const healthcheck = shared.healthcheck ? formatCommand(shared.healthcheck) : '(none)'
  return `requireRunning=${shared.requireRunning ? 'yes' : 'no'} healthcheck=${healthcheck}`
}

function formatDedicatedEnv(repo: ProjectRepoSummary): string {
  const dedicated = repo.environment?.dedicated
  if (!dedicated) return '(not configured)'

  const services = dedicated.compose.services.length > 0
    ? dedicated.compose.services.join(',')
    : '(all)'
  const healthcheck = dedicated.healthcheck ? formatCommand(dedicated.healthcheck) : '(none)'

  return `compose=${dedicated.compose.file} services=${services} project=${dedicated.compose.projectName} copyFrom=${dedicated.env.copyFrom} overrideKeys=${dedicated.env.overrideKeys.length} overrideFiles=${dedicated.env.overrideFiles.length} healthcheck=${healthcheck} teardown=${dedicated.teardownOnComplete ? 'yes' : 'no'}`
}

function formatLabelPresentation(repo: ProjectRepoSummary): string {
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

function flag(value: boolean): string {
  return value ? 'custom' : 'default'
}

function formatShellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value)
}
