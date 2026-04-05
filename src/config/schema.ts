import { z } from 'zod'

// --- Notification channel schemas ---

const ConsoleChannelSchema = z.object({
  type: z.literal('console'),
})

const WebhookChannelSchema = z.object({
  type: z.literal('webhook'),
  urlEnv: z.string(),
})

const SmtpChannelSchema = z.object({
  type: z.literal('smtp'),
  host: z.string(),
  port: z.number().int().positive().default(587),
  from: z.string(),
  to: z.string(),
  userEnv: z.string(),
  passEnv: z.string(),
})

const NotificationChannelSchema = z.discriminatedUnion('type', [
  ConsoleChannelSchema,
  WebhookChannelSchema,
  SmtpChannelSchema,
])

const NotificationEventsSchema = z.object({
  onRunStarted: z.boolean().default(false),
  onBlocked: z.boolean().default(true),
  onPrReady: z.boolean().default(true),
  onError: z.boolean().default(true),
  onRetryExhausted: z.boolean().default(true),
})

// --- App mention schemas ---

const AppMentionSchema = z.object({
  enabled: z.boolean().default(false),
  commentTemplate: z.string(),
})

// --- Worker profile schema ---

const WorkerProfileSchema = z.object({
  type: z.string().min(1, 'Worker type must not be empty'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  workerTimeoutSeconds: z.number().positive().default(1800),
  minimalEnv: z.boolean().default(true),
  runtimeWrapper: z.string().nullable().default(null),
  env: z.record(z.string()).default({}),
})

const CommandSpecSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
])

// --- Environment schemas ---

const BootstrapFailureHintSchema = z.object({
  contains: z.string().min(1),
  message: z.string().min(1),
  output: z.enum(['combined', 'stdout', 'stderr']).default('combined'),
})

const BootstrapCommandSchema = z.object({
  command: CommandSpecSchema,
  when: z.enum(['always', 'dedicated', 'shared']).default('always'),
  failureHints: z.array(BootstrapFailureHintSchema).default([]),
})

const DedicatedEnvSchema = z.object({
  compose: z.object({
    file: z.string(),
    services: z.array(z.string()).default([]),
    projectName: z.string().default('orch-{issue}'),
  }),
  env: z.object({
    copyFrom: z.string().default('.env'),
    overrides: z.record(z.string()).default({}),
    overrideFiles: z.array(z.string()).default([]),
  }).default({}),
  healthcheck: CommandSpecSchema.optional(),
  teardownOnComplete: z.boolean().default(true),
})

const SharedEnvSchema = z.object({
  requireRunning: z.boolean().default(true),
  healthcheck: CommandSpecSchema.optional(),
})

const EnvironmentConfigSchema = z.object({
  defaultMode: z.enum(['shared', 'dedicated']).default('shared'),
  dedicated: DedicatedEnvSchema.optional(),
  shared: SharedEnvSchema.optional(),
  bootstrap: z.array(BootstrapCommandSchema).default([]),
  cleanup: z.array(BootstrapCommandSchema).default([]),
})

// --- Repo label schemas ---

const LabelsSchema = z.object({
  ready: z.union([z.string(), z.array(z.string())]).transform(v =>
    Array.isArray(v) ? v : [v],
  ),
  running: z.string().default('orch:running'),
  blocked: z.union([
    z.string(),
    z.array(z.string()).transform(v => v[0] ?? 'orch:blocked'),
  ]).default('orch:blocked'),
  needsHuman: z.string().default('orch:needs-human'),
  reviewReady: z.string().default('orch:review-ready'),
  error: z.string().default('orch:error'),
  retry: z.string().default('orch:retry'),
  planning: z.string().default('orch:planning'),
  mergeQueued: z.string().default('orch:merge-queued'),
  merging: z.string().default('orch:merging'),
  mergeFailed: z.string().default('orch:merge-failed'),
})

const LinkedProjectSchema = z
  .string()
  .regex(/^[^/]+\/[^/]+$/, 'Must be in format owner/name')

const KanbanSchema = z.object({
  triggerLabel: z.string().min(1, 'triggerLabel must not be empty'),
  labels: LabelsSchema,
})

const LabelPresentationSchema = z.object({
  color: z.string().regex(/^[0-9A-Fa-f]{6}$/, 'Color must be a 6-character hex value').optional(),
  description: z.string().max(100, 'Description must be 100 characters or fewer').optional(),
}).refine((value) => value.color !== undefined || value.description !== undefined, {
  message: 'At least one of color or description must be provided',
})

const DefaultsSchema = z.object({
  planner: z.enum(['claude', 'codex']).default('claude'),
  coder: z.enum(['claude', 'codex']).default('claude'),
  reviewer: z.enum(['claude', 'codex']).default('claude'),
  doneMode: z.enum(['pr-ready', 'manual-only']).default('pr-ready'),
  notifyPriority: z.enum(['normal', 'high']).default('normal'),
  prMentions: z.array(z.string()).default([]),
})

const SelectorsSchema = z.object({
  includeLabelsAny: z.array(z.string()).default(['orch:ready']),
  excludeLabelsAny: z.array(z.string()).default(['orch:blocked', 'orch:error', 'orch:needs-human']),
})

const PromptsSchema = z.object({
  plannerSystem: z.string().optional(),
  coderSystem: z.string().optional(),
  reviewerSystem: z.string().optional(),
})

const PlanningConfigSchema = z.object({
  prdDirectory: z.string().default('docs/prd'),
})

// --- Workflow schemas ---

const WorkflowWorkerStepSchema = z.object({
  type: z.literal('worker'),
  id: z.string(),
  role: z.string(),
  skipWhen: z.string().optional(),
  continueFrom: z.string().optional(),
  prompt: z.string().optional(),
})

const WorkflowVerifyStepSchema = z.object({
  type: z.literal('verify'),
  id: z.string(),
  skipWhen: z.string().optional(),
})

const WorkflowDecideStepSchema = z.object({
  type: z.literal('decide'),
  id: z.string(),
  onIterate: z.string(),
  requireReview: z.boolean().optional(),
})

const WorkflowStepSchema = z.discriminatedUnion('type', [
  WorkflowWorkerStepSchema,
  WorkflowVerifyStepSchema,
  WorkflowDecideStepSchema,
])

const WorkflowRoleOverridesSchema = z.object({
  planner: z.enum(['claude', 'codex']).optional(),
  coder: z.enum(['claude', 'codex']).optional(),
  reviewer: z.enum(['claude', 'codex']).optional(),
})

const WorkflowSchema = z.object({
  steps: z.array(WorkflowStepSchema).min(1),
  roles: WorkflowRoleOverridesSchema.optional(),
  agents: z.record(z.string()).optional(),
})

const WorkflowByTriageSchema = z.object({
  trivial: z.string().optional(),
  standard: z.string().optional(),
}).strict()

// --- Merge queue schema ---

const MergeQueueSchema = z.object({
  enabled: z.boolean().default(false),
  batchSize: z.number().int().min(1).max(20).default(5),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  retryFlakyOnce: z.boolean().default(true),
  requireApproval: z.boolean().default(true),
  stagingBranchPrefix: z.string().default('orch/staging'),
})

// --- Repo schema ---

const RepoConfigSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in format owner/name'),
  forge: z.enum(['github', 'forgejo']).default('github'),
  linkedProjects: z.array(LinkedProjectSchema).default([]),
  apiBaseUrl: z.string().url().optional(),
  tokenEnv: z.string().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(20).default(1),
  localPath: z.string(),
  baseBranch: z.string().default('main'),
  branchPrefix: z.string().default('orch'),
  labels: LabelsSchema.default({ ready: ['orch:ready'] }),
  kanban: KanbanSchema.optional(),
  labelConfig: z.record(LabelPresentationSchema).default({}),
  defaults: DefaultsSchema.default({}),
  environment: EnvironmentConfigSchema.optional(),
  verify: z.array(CommandSpecSchema).default([]),
  prompts: PromptsSchema.optional(),
  planning: PlanningConfigSchema.default({}),
  selectors: SelectorsSchema.default({}),
  agents: z.record(z.string()).default({}),
  workflow: z.string().optional(),
  workflowByTriage: WorkflowByTriageSchema.optional(),
  mergeQueue: MergeQueueSchema.default({}),
})

// --- Security schema ---

const SecuritySchema = z.object({
  maxChangedFiles: z.number().positive().default(50),
  maxChangedLines: z.number().positive().default(5000),
  maxDailyCostUsd: z.number().positive().default(50),
  maxCostPerRunUsd: z.number().positive().default(10),
})

// --- Cost schema ---

const CostModelSchema = z.enum(['pay-per-use', 'subscription'])

const CostSchema = z.object({
  model: CostModelSchema.default('pay-per-use'),
})

// --- Metrics schema ---

const MetricsSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().positive().default(9090),
  host: z.string().default('0.0.0.0'),
})

// --- Observability schema ---

const ObservabilitySchema = z.object({
  agentStreaming: z.boolean().default(true),
  eventRetention: z.number().int().min(100).max(10_000).default(1000),
  sessionLogs: z.boolean().default(true),
  sessionLogRetention: z.number().int().positive().default(7),
})

// --- Top-level config schema ---

export const ConfigSchema = z.object({
  version: z.literal(1),

  github: z.object({
    tokenEnv: z.string().refine(
      (val) => !val.startsWith('ghp_') && !val.startsWith('ghs_') && !val.startsWith('github_pat_'),
      { message: 'tokenEnv should be an environment variable name, not a literal token' },
    ),
    apiBaseUrl: z.string().url().default('https://api.github.com'),
    pollIntervalSeconds: z.number().positive().default(300),
    appMentions: z.record(AppMentionSchema).default({}),
  }),

  storage: z.object({
    dbPath: z.string().default('~/.config/night-orch/state.db'),
    worktreeRoot: z.string().default('~/code/.night-orch/worktrees'),
    logsRoot: z.string().default('~/code/.night-orch/logs'),
    autoCleanup: z.object({
      enabled: z.boolean().default(true),
      intervalMinutes: z.number().positive().default(60),
    }).default({}),
    retention: z.object({
      worktreeAgeDays: z.number().positive().default(7),
      detailDays: z.number().positive().default(30),
      archiveDays: z.number().positive().default(90),
    }).default({}),
  }).default({}),

  notifications: z.object({
    channels: z.array(NotificationChannelSchema).default([{ type: 'console' as const }]),
    events: NotificationEventsSchema.default({}),
  }).default({}),

  loop: z.object({
    maxReviewIterations: z.number().positive().default(4),
    maxTotalAgentPasses: z.number().positive().default(10),
    stopOnPlannerFailure: z.boolean().default(true),
    requireVerificationPass: z.boolean().default(true),
    reviewApprovalKeyword: z.string().default('APPROVED'),
    reviewNeedsChangesKeyword: z.string().default('CHANGES_REQUIRED'),
    blockOnAmbiguousReview: z.boolean().default(true),
    maxAutoRetries: z.number().int().min(0).default(3),
    decompose: z.boolean().default(false),
    maxSubtasks: z.number().int().min(1).max(10).default(5),
    maxConcurrentSubtasks: z.number().int().min(1).max(10).default(3),
  }).default({}),

  security: SecuritySchema.default({}),

  cost: CostSchema.default({}),

  workerProfiles: z.record(WorkerProfileSchema).default({}),

  metrics: MetricsSchema.default({}),

  observability: ObservabilitySchema.default({}),

  mcp: z.object({
    enabled: z.boolean().default(false),
    transport: z.enum(['stdio']).default('stdio'),
    authTokenEnv: z.string().nullable().default(null),
    httpPort: z.number().int().positive().default(3100),
    httpHost: z.string().default('127.0.0.1'),
  }).default({}),

  commentCommands: z.object({
    enabled: z.boolean().default(true),
    requireCollaborator: z.boolean().default(false),
  }).default({}),

  repos: z.array(RepoConfigSchema).min(1, 'At least one repository must be configured'),

  workflows: z.record(WorkflowSchema).default({}),
})

export type Config = z.infer<typeof ConfigSchema>
export type RepoConfig = z.infer<typeof RepoConfigSchema>
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>
export type CostModel = z.infer<typeof CostModelSchema>
