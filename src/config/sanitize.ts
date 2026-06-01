import type { RepoConfig, WorkerProfile } from './schema.js'

export type CommandSpec = string | string[]
export type VerifyCommandSpec = CommandSpec | { command: CommandSpec; timeoutSeconds: number }
export type CommandWhen = 'always' | 'dedicated' | 'shared'

export interface ProjectWorkerProfileSummary {
  type: string
  command: string
  args: string[]
  workerTimeoutSeconds: number
  minimalEnv: boolean
  runtimeWrapper: string | null
  envKeys: string[]
}

export interface ProjectLabels {
  ready: string[]
  running: string
  blocked: string
  needsHuman: string
  reviewReady: string
  error: string
  retry: string
  planning: string
  mergeQueued: string
  merging: string
  mergeFailed: string
}

export interface ProjectRepoSummary {
  repo: string
  forge: 'github' | 'forgejo'
  linkedProjects: string[]
  apiBaseUrl?: string
  tokenEnv?: string
  maxConcurrentRuns: number
  localPath: string
  baseBranch: string
  branchPrefix: string
  labels: ProjectLabels
  kanban?: {
    triggerLabel: string
    labels: ProjectLabels
  }
  labelConfig: Record<string, { color?: string; description?: string }>
  defaults: {
    planner: 'claude' | 'codex' | 'opencode'
    coder: 'claude' | 'codex' | 'opencode'
    reviewer: 'claude' | 'codex' | 'opencode'
    doneMode: 'pr-ready' | 'manual-only'
    notifyPriority: 'normal' | 'high'
    prMentions: string[]
  }
  environment?: {
    defaultMode: 'shared' | 'dedicated'
    dedicated?: {
      compose: {
        file: string
        services: string[]
        projectName: string
      }
      env: {
        copyFrom: string
        overrideKeys: string[]
        overrideFiles: string[]
      }
      healthcheck?: CommandSpec
      teardownOnComplete: boolean
    }
    shared?: {
      requireRunning: boolean
      healthcheck?: CommandSpec
    }
    bootstrap: Array<{
      command: CommandSpec
      when: CommandWhen
      failureHints?: Array<{
        contains: string
        message: string
        output: 'combined' | 'stdout' | 'stderr'
      }>
    }>
    cleanup: Array<{
      command: CommandSpec
      when: CommandWhen
      failureHints?: Array<{
        contains: string
        message: string
        output: 'combined' | 'stdout' | 'stderr'
      }>
    }>
  }
  verify: VerifyCommandSpec[]
  prompts: {
    plannerSystem: boolean
    coderSystem: boolean
    reviewerSystem: boolean
  }
  planning: {
    prdDirectory: string
  }
  selectors: {
    includeLabelsAny: string[]
    excludeLabelsAny: string[]
  }
  agents: Record<string, string>
  workflow?: string
  workflowByTriage?: {
    trivial?: string
    standard?: string
  }
  mergeQueue: {
    enabled: boolean
    batchSize: number
    mergeMethod: 'merge' | 'squash' | 'rebase'
    retryFlakyOnce: boolean
    requireApproval: boolean
    stagingBranchPrefix: string
  }
}

export function sanitizeWorkerProfile(profile: WorkerProfile): ProjectWorkerProfileSummary {
  return {
    type: profile.type,
    command: profile.command,
    args: [...profile.args],
    workerTimeoutSeconds: profile.workerTimeoutSeconds,
    minimalEnv: profile.minimalEnv,
    runtimeWrapper: profile.runtimeWrapper,
    envKeys: Object.keys(profile.env),
  }
}

export function sanitizeProjectRepo(repo: RepoConfig): ProjectRepoSummary {
  return {
    repo: repo.repo,
    forge: repo.forge,
    linkedProjects: [...repo.linkedProjects],
    apiBaseUrl: repo.apiBaseUrl,
    tokenEnv: repo.tokenEnv,
    maxConcurrentRuns: repo.maxConcurrentRuns,
    localPath: repo.localPath,
    baseBranch: repo.baseBranch,
    branchPrefix: repo.branchPrefix,
    labels: sanitizeLabels(repo.labels),
    ...(repo.kanban
      ? {
          kanban: {
            triggerLabel: repo.kanban.triggerLabel,
            labels: sanitizeLabels(repo.kanban.labels),
          },
        }
      : {}),
    labelConfig: Object.fromEntries(
      Object.entries(repo.labelConfig).map(([label, config]) => [
        label,
        {
          ...(config.color ? { color: config.color } : {}),
          ...(config.description ? { description: config.description } : {}),
        },
      ]),
    ),
    defaults: {
      planner: repo.defaults.planner,
      coder: repo.defaults.coder,
      reviewer: repo.defaults.reviewer,
      doneMode: repo.defaults.doneMode,
      notifyPriority: repo.defaults.notifyPriority,
      prMentions: [...repo.defaults.prMentions],
    },
    ...(repo.environment ? { environment: sanitizeEnvironment(repo.environment) } : {}),
    verify: repo.verify.map((command) => copyVerifyCommandSpec(command)),
    prompts: {
      plannerSystem: Boolean(repo.prompts?.plannerSystem),
      coderSystem: Boolean(repo.prompts?.coderSystem),
      reviewerSystem: Boolean(repo.prompts?.reviewerSystem),
    },
    planning: {
      prdDirectory: repo.planning.prdDirectory,
    },
    selectors: {
      includeLabelsAny: [...repo.selectors.includeLabelsAny],
      excludeLabelsAny: [...repo.selectors.excludeLabelsAny],
    },
    agents: { ...repo.agents },
    ...(repo.workflow ? { workflow: repo.workflow } : {}),
    ...(repo.workflowByTriage ? { workflowByTriage: { ...repo.workflowByTriage } } : {}),
    mergeQueue: {
      enabled: repo.mergeQueue.enabled,
      batchSize: repo.mergeQueue.batchSize,
      mergeMethod: repo.mergeQueue.mergeMethod,
      retryFlakyOnce: repo.mergeQueue.retryFlakyOnce,
      requireApproval: repo.mergeQueue.requireApproval,
      stagingBranchPrefix: repo.mergeQueue.stagingBranchPrefix,
    },
  }
}

function sanitizeEnvironment(environment: NonNullable<RepoConfig['environment']>): NonNullable<ProjectRepoSummary['environment']> {
  return {
    defaultMode: environment.defaultMode,
    ...(environment.dedicated
      ? {
          dedicated: {
            compose: {
              file: environment.dedicated.compose.file,
              services: [...environment.dedicated.compose.services],
              projectName: environment.dedicated.compose.projectName,
            },
            env: {
              copyFrom: environment.dedicated.env.copyFrom,
              overrideKeys: Object.keys(environment.dedicated.env.overrides),
              overrideFiles: [...environment.dedicated.env.overrideFiles],
            },
            ...(environment.dedicated.healthcheck
              ? { healthcheck: copyCommandSpec(environment.dedicated.healthcheck) }
              : {}),
            teardownOnComplete: environment.dedicated.teardownOnComplete,
          },
        }
      : {}),
    ...(environment.shared
      ? {
          shared: {
            requireRunning: environment.shared.requireRunning,
            ...(environment.shared.healthcheck
              ? { healthcheck: copyCommandSpec(environment.shared.healthcheck) }
              : {}),
          },
        }
      : {}),
    bootstrap: environment.bootstrap.map((step) => ({
      when: step.when,
      command: copyCommandSpec(step.command),
      ...(step.failureHints && step.failureHints.length > 0
        ? {
            failureHints: step.failureHints.map((hint) => ({
              contains: hint.contains,
              message: hint.message,
              output: hint.output,
            })),
          }
        : {}),
    })),
    cleanup: environment.cleanup.map((step) => ({
      when: step.when,
      command: copyCommandSpec(step.command),
      ...(step.failureHints && step.failureHints.length > 0
        ? {
            failureHints: step.failureHints.map((hint) => ({
              contains: hint.contains,
              message: hint.message,
              output: hint.output,
            })),
          }
        : {}),
    })),
  }
}

function sanitizeLabels(labels: RepoConfig['labels']): ProjectLabels {
  return {
    ready: [...labels.ready],
    running: labels.running,
    blocked: normalizeLabelValue(labels.blocked),
    needsHuman: labels.needsHuman,
    reviewReady: labels.reviewReady,
    error: labels.error,
    retry: labels.retry,
    planning: labels.planning,
    mergeQueued: labels.mergeQueued,
    merging: labels.merging,
    mergeFailed: labels.mergeFailed,
  }
}

function normalizeLabelValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === 'string') ?? ''
  }
  return ''
}

function copyCommandSpec(command: CommandSpec): CommandSpec {
  if (Array.isArray(command)) {
    return [...command]
  }
  return command
}

function copyVerifyCommandSpec(command: VerifyCommandSpec): VerifyCommandSpec {
  if (Array.isArray(command) || typeof command === 'string') {
    return copyCommandSpec(command)
  }

  return {
    command: copyCommandSpec(command.command),
    timeoutSeconds: command.timeoutSeconds,
  }
}
