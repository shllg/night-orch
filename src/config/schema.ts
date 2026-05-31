import { z } from 'zod'

// --- Notification channel schemas ---

const ConsoleChannelSchema = z.object({
  type: z.literal('console'),
})

const WebhookChannelSchema = z.object({
  type: z.literal('webhook'),
  urlEnv: z.string(),
})

const DiscordChannelSchema = z.object({
  type: z.literal('discord'),
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

/**
 * Phase 2c: Web Push notifications to browsers that subscribed via
 * the web UI. All three VAPID values are env-var references so the
 * private key never lands in YAML. Generate keys with:
 *   npx web-push generate-vapid-keys
 * Then export e.g.:
 *   NIGHT_ORCH_VAPID_PUBLIC=<public>
 *   NIGHT_ORCH_VAPID_PRIVATE=<private>
 *   NIGHT_ORCH_VAPID_SUBJECT=mailto:you@example.com
 */
const WebPushChannelSchema = z.object({
  type: z.literal('webpush'),
  vapidPublicKeyEnv: z.string(),
  vapidPrivateKeyEnv: z.string(),
  vapidSubjectEnv: z.string(),
})

export const NotificationChannelSchema = z.discriminatedUnion('type', [
  ConsoleChannelSchema,
  WebhookChannelSchema,
  DiscordChannelSchema,
  SmtpChannelSchema,
  WebPushChannelSchema,
])

const NotificationEventsSchema = z.object({
  onRunStarted: z.boolean().default(false),
  onBlocked: z.boolean().default(true),
  onPrReady: z.boolean().default(true),
  onPrUpdated: z.boolean().default(true),
  onError: z.boolean().default(true),
  onRetryExhausted: z.boolean().default(true),
})

// --- App mention schemas ---

export const AppMentionSchema = z.object({
  enabled: z.boolean().default(false),
  commentTemplate: z.string(),
})

// --- Worker profile schema ---

const WorkerSandboxMountSchema = z.object({
  hostPath: z.string().min(1),
  sandboxPath: z.string().min(1),
  readonly: z.boolean().optional(),
})

const WorkerSandboxSchema = z.object({
  type: z.enum(['host', 'docker', 'podman']).default('host'),
  image: z.string().min(1).optional(),
  containerUid: z.number().int().positive().optional(),
  containerGid: z.number().int().positive().optional(),
  mounts: z.array(WorkerSandboxMountSchema).default([]),
  env: z.record(z.string()).default({}),
  network: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
})

export const WorkerProfileSchema = z.object({
  type: z.string().min(1, 'Worker type must not be empty'),
  pricingModel: z.string().min(1).optional(),
  minuteUsd: z.number().nonnegative().optional(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  workerTimeoutSeconds: z.number().positive().default(1800),
  /** @deprecated Ignored at runtime — always uses whitelist-only env mode. */
  minimalEnv: z.boolean().default(true),
  runtimeWrapper: z.string().nullable().default(null),
  env: z.record(z.string()).default({}),
  sandbox: WorkerSandboxSchema.default({ type: 'host' }),
})

const CommandSpecSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
])

const VerifyCommandSchema = z.union([
  CommandSpecSchema,
  z.object({
    command: CommandSpecSchema,
    timeoutSeconds: z.number().int().positive(),
  }).strict(),
])

export const VerificationStageSchema = z.object({
  id: z.string(),
  commands: z.array(VerifyCommandSchema).min(1),
  timeoutSeconds: z.number().int().positive().optional(),
  required: z.boolean().default(true),
  onFailure: z.enum(['block', 'iterate', 'warn']).default('block'),
})

export const VerificationProfileSchema = z.object({
  stages: z.array(VerificationStageSchema).min(1),
})

/**
 * Preflight drift gate. Before dispatching fresh work in a poll cycle,
 * run a fast check against the repo's base branch HEAD. If the base is
 * already red (drift not caused by any queued issue), the whole batch is
 * skipped for that cycle instead of letting every issue fail in series
 * and inject unrelated stale-base reverts into diffs.
 *
 * Command resolution cascade: `commands` (explicit) → the named `stage`
 * of the repo's `verificationProfile` → the repo's `verify[]`.
 */
const PreflightSchema = z.object({
  enabled: z.boolean().default(false),
  /** Stage id within the repo's verificationProfile to run as the gate. */
  stage: z.string().optional(),
  /** Explicit commands to run; overrides stage/verify resolution. */
  commands: z.array(VerifyCommandSchema).optional(),
}).default({})

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
  running: z.string().default('no:running'),
  blocked: z.union([
    z.string(),
    z.array(z.string()).transform(v => v[0] ?? 'no:blocked'),
  ]).default('no:blocked'),
  needsHuman: z.string().default('no:needs-human'),
  reviewReady: z.string().default('no:review-ready'),
  error: z.string().default('no:error'),
  retry: z.string().default('no:retry'),
  planning: z.string().default('no:planning'),
  mergeQueued: z.string().default('no:merge-queued'),
  merging: z.string().default('no:merging'),
  mergeFailed: z.string().default('no:merge-failed'),
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
  planner: z.enum(['claude', 'codex', 'opencode']).default('claude'),
  coder: z.enum(['claude', 'codex', 'opencode']).default('codex'),
  reviewer: z.enum(['claude', 'codex', 'opencode']).default('codex'),
  /** @deprecated Reserved — not read by the loop engine or notification dispatch. */
  doneMode: z.enum(['pr-ready', 'manual-only']).default('pr-ready'),
  /** @deprecated Reserved — not read by the notification dispatch. */
  notifyPriority: z.enum(['normal', 'high']).default('normal'),
  prMentions: z.array(z.string()).default([]),
})

const SelectorsSchema = z.object({
  includeLabelsAny: z.array(z.string()).default(['no:ready']),
  excludeLabelsAny: z.array(z.string()).default(['no:blocked', 'no:error', 'no:needs-human']),
})

const PromptsSchema = z.object({
  plannerSystem: z.string().optional(),
  coderSystem: z.string().optional(),
  reviewerSystem: z.string().optional(),
})

const PlanningConfigSchema = z.object({
  prdDirectory: z.string().default('docs/prd'),
})

const FileLoopVerifyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  commands: z.array(z.string()).default(['pnpm typecheck']),
  timeoutSeconds: z.number().int().positive().default(60),
})

const FileLoopFinalizeVerifyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  commands: z.array(z.string()).default(['pnpm typecheck', 'pnpm lint']),
  timeoutSeconds: z.number().int().positive().default(300),
  onFailure: z.enum(['draft-pr', 'no-pr']).default('draft-pr'),
})

export const FileLoopConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxDurationMinutes: z.number().int().positive().default(480),
  maxIterations: z.number().int().positive().default(1000),
  minIntervalSecondsBetweenFiles: z.number().int().min(0).default(5),
  perIterationTimeoutSeconds: z.number().int().positive().default(120),
  maxCostUsd: z.number().nonnegative().default(5),
  maxFileLines: z.number().int().positive().default(1500),
  includeGlobs: z.array(z.string()).default(['**/*.{ts,tsx,js,jsx,py,go,rs,md}']),
  excludeGlobs: z.array(z.string()).default([
    '**/node_modules/**',
    '**/dist/**',
    '**/.env*',
    '**/*.lock',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/*.snap',
    '**/*.min.*',
    '**/.git/**',
    'loop.md',
  ]),
  reviewerProfileKey: z.string().default('claude-cheap'),
  branchNameTemplate: z.string().default('orch/file-loop/{repoSlug}/{yyyyMmDd}'),
  loopMdPath: z.string().default('loop.md'),
  commitPrefix: z.string().default('[FILE-LOOP]'),
  perEditVerify: FileLoopVerifyConfigSchema.default({}),
  finalizeVerify: FileLoopFinalizeVerifyConfigSchema.default({}),
}).strict()

const RepoFileLoopConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxDurationMinutes: z.number().int().positive().optional(),
  maxIterations: z.number().int().positive().optional(),
  minIntervalSecondsBetweenFiles: z.number().int().min(0).optional(),
  perIterationTimeoutSeconds: z.number().int().positive().optional(),
  maxCostUsd: z.number().nonnegative().optional(),
  maxFileLines: z.number().int().positive().optional(),
  includeGlobs: z.array(z.string()).optional(),
  excludeGlobs: z.array(z.string()).optional(),
  reviewerProfileKey: z.string().optional(),
  branchNameTemplate: z.string().optional(),
  loopMdPath: z.string().optional(),
  commitPrefix: z.string().optional(),
  perEditVerify: z.object({
    enabled: z.boolean().optional(),
    commands: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  }).strict().optional(),
  finalizeVerify: z.object({
    enabled: z.boolean().optional(),
    commands: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    onFailure: z.enum(['draft-pr', 'no-pr']).optional(),
  }).strict().optional(),
}).strict()

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
  profile: z.string().optional(),
  stage: z.string().optional(),
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

const WorkflowDagWorkerStageSchema = z.object({
  type: z.literal('worker'),
  role: z.string(),
  skipWhen: z.string().optional(),
  continueFrom: z.string().optional(),
  prompt: z.string().optional(),
  next: z.string().optional(),
  retry: z.number().int().min(0).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  onError: z.enum(['continue', 'iterate', 'block']).optional(),
})

const WorkflowDagVerifyStageSchema = z.object({
  type: z.literal('verify'),
  skipWhen: z.string().optional(),
  profile: z.string().optional(),
  stage: z.string().optional(),
  next: z.string().optional(),
  retry: z.number().int().min(0).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  onError: z.enum(['continue', 'iterate', 'block']).optional(),
})

const WorkflowDagDecideStageSchema = z.object({
  type: z.literal('decide'),
  onIterate: z.string(),
  requireReview: z.boolean().optional(),
  retry: z.number().int().min(0).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  onError: z.enum(['continue', 'iterate', 'block']).optional(),
})

const WorkflowDagStageSchema = z.discriminatedUnion('type', [
  WorkflowDagWorkerStageSchema,
  WorkflowDagVerifyStageSchema,
  WorkflowDagDecideStageSchema,
])

const WorkflowDagSchema = z.object({
  entry: z.string(),
  stages: z.record(WorkflowDagStageSchema),
}).superRefine((value, ctx) => {
  if (Object.keys(value.stages).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stages'],
      message: 'Workflow DAG requires at least one stage',
    })
  }
  if (!(value.entry in value.stages)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entry'],
      message: `Workflow DAG entry "${value.entry}" must reference an existing stage`,
    })
  }
})

const WorkflowRoleOverridesSchema = z.object({
  planner: z.enum(['claude', 'codex', 'opencode']).optional(),
  coder: z.enum(['claude', 'codex', 'opencode']).optional(),
  reviewer: z.enum(['claude', 'codex', 'opencode']).optional(),
})

export const WorkflowSchema = z.object({
  steps: z.array(WorkflowStepSchema).min(1).optional(),
  dag: WorkflowDagSchema.optional(),
  roles: WorkflowRoleOverridesSchema.optional(),
  agents: z.record(z.string()).optional(),
}).superRefine((value, ctx) => {
  if (!value.steps && !value.dag) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['steps'],
      message: 'Workflow must define either steps or dag',
    })
  }
  if (value.steps && value.dag) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['steps'],
      message: 'Workflow cannot define both steps and dag',
    })
  }
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
  /** How to incorporate upstream base branch changes into work branches.
   *  'merge' (default) creates merge commits — reliable for automated systems.
   *  'rebase' replays commits for linear history — fragile with conflicts. */
  updateStrategy: z.enum(['merge', 'rebase']).default('merge'),
  labels: LabelsSchema.default({ ready: ['no:ready'] }),
  kanban: KanbanSchema.optional(),
  labelConfig: z.record(LabelPresentationSchema).default({}),
  defaults: DefaultsSchema.default({}),
  environment: EnvironmentConfigSchema.optional(),
  verify: z.array(VerifyCommandSchema).default([]),
  verificationProfile: z.string().optional(),
  preflight: PreflightSchema.default({}),
  prompts: PromptsSchema.optional(),
  planning: PlanningConfigSchema.default({}),
  fileLoop: RepoFileLoopConfigSchema.default({}),
  selectors: SelectorsSchema.default({}),
  agents: z.record(z.string()).default({}),
  workflow: z.string().optional(),
  workflowByTriage: WorkflowByTriageSchema.optional(),
  mergeQueue: MergeQueueSchema.default({}),
}).superRefine((repo, ctx) => {
  // The merge queue relies on `getPRCheckStatus`, `getRefCheckStatus`, and
  // `updateRef` which are only implemented in the GitHub adapter. Enabling
  // mergeQueue for a Forgejo repo would silently skip CI verification and
  // direct-ref fast-forward pushes. Reject at config-load time with a
  // clear message until the Forgejo adapter implements the missing methods.
  if (repo.forge === 'forgejo' && repo.mergeQueue.enabled) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mergeQueue', 'enabled'],
      message: 'mergeQueue.enabled is not supported on Forgejo repos (forge adapter lacks check-status/ref-update methods).',
    })
  }
})

// --- Security schema ---

const SecuritySchema = z.object({
  maxChangedFiles: z.number().positive().default(50),
  maxChangedLines: z.number().positive().default(5000),
  maxDailyCostUsd: z.number().positive().default(50),
  maxCostPerRunUsd: z.number().positive().default(10),
})

// --- Cost schema ---

const CostModelSchema = z.enum(['pay-per-use', 'subscription', 'subscription-metered'])

export const CostPricingModelSchema = z.object({
  inputUsdPerMillionTokens: z.number().nonnegative().default(3),
  outputUsdPerMillionTokens: z.number().nonnegative().default(15),
  cacheReadUsdPerMillionTokens: z.number().nonnegative().default(0.3),
  minuteUsd: z.number().nonnegative().default(0.008),
})

const CostPricingSchema = z.object({
  defaultModel: z.string().min(1).default('default'),
  models: z.record(CostPricingModelSchema).default({}),
})

export const SubscriptionMeteredSchema = z.object({
  advisoryThresholdUsd: z.number().positive().nullable().default(null),
  enforcePerRunLimit: z.boolean().default(false),
  enforceDailyLimit: z.boolean().default(false),
}).default({})

/**
 * Subscription quota tracking. A subscription plan includes a fixed
 * amount of usage before billing swaps to usage-based (metered).
 * `includedUsd` is that included allowance expressed in theoretical
 * (layer-2) dollars. When cumulative theoretical cost for the `period`
 * exceeds it, the quota is exhausted and real charges begin:
 *  - `warn`    → log once per period; keep running (default).
 *  - `enforce` → treat the overage as metered spend and apply
 *                `security.maxDailyCostUsd` against it, so a blown
 *                quota can actually block new work.
 */
export const SubscriptionQuotaSchema = z.object({
  includedUsd: z.number().positive(),
  period: z.enum(['day', 'month']).default('month'),
  onExhausted: z.enum(['warn', 'enforce']).default('warn'),
})

const CostSchema = z.object({
  model: CostModelSchema.default('pay-per-use'),
  pricing: CostPricingSchema.optional(),
  subscriptionMetered: SubscriptionMeteredSchema,
  subscriptionQuota: SubscriptionQuotaSchema.optional(),
  /**
   * R4a escape hatch: when `false` (default), worker invocations that
   * return without parseable token usage cause the attempt to be
   * blocked with `tokenCaptureFailed` instead of silently falling
   * back to a duration-based cost estimate. The duration estimate
   * undercounted by 10-100× in production and was the root cause of
   * the "realistic cost measurement" issue documented in the plan.
   *
   * Set to `true` only as a temporary unblocker when a worker adapter
   * is genuinely unable to report token usage and you'd rather pay
   * with degraded accuracy than block the run. Each duration-based
   * row will be tagged `token_source = 'estimated_duration'` once R4b
   * lands so reports can surface the degradation.
   */
  allowEstimatedDuration: z.boolean().default(false),
})

// --- Metrics schema ---

const MetricsSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().positive().default(9090),
  host: z.string().default('0.0.0.0'),
})

const AutoResolveConflictsSchema = z.object({
  enabled: z.boolean().default(true),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  maxFiles: z.number().int().min(1).max(20).default(5),
}).default({})

// --- Observability schema ---

const ObservabilitySchema = z.object({
  agentStreaming: z.boolean().default(true),
  eventRetention: z.number().int().min(100).max(10_000).default(1000),
  sessionLogs: z.boolean().default(true),
  sessionLogRetention: z.number().int().positive().default(7),
})

// --- AI (Phase 3 direct-LLM) schema ---
//
// Configures a direct LLM API client for night-orch's INTERNAL AI
// tasks — triage classification, PR description generation,
// reviewer parse-failure salvage. Does NOT replace the Claude Code
// / Codex / opencode CLIs used for code-editing work; those stay
// on the CLI path because they rely on the agentic tool-use loop.
//
// All per-feature consumers gate on a flag under `ai.internal.enable.*`
// so operators can adopt gradually. When `provider` is unset the
// entire layer is no-op and every consumer falls through to its
// pre-Phase-3 behavior (rule-based triage, raw parser output,
// templated PR body).
const AiEnableSchema = z.object({
  /** Use the LLM to refine rule-based triage decisions. Falls
   * back to the heuristic classifier on any error. */
  triage: z.boolean().default(false),
  /** When the primary reviewer parser fails and this flag is true,
   * ask the LLM to salvage the structured output instead of
   * blocking with ambiguousReview. */
  reviewerParseFallback: z.boolean().default(false),
  /** Generate richer PR descriptions from the run context
   * (objective, code summary, test strategy). */
  prBody: z.boolean().default(false),
}).default({})

const AiFeaturesSchema = z.object({
  /** Allow the direct-LLM layer to attempt a bounded rebase-conflict
   * resolution pass before blocking for human intervention. */
  conflictResolver: z.boolean().default(true),
}).default({})

const AiInternalSchema = z.object({
  provider: z.enum(['anthropic', 'openrouter', 'openai']).nullable().default(null),
  model: z.string().nullable().default(null),
  /** Env var name that holds the API key. Refuses literal keys in
   * YAML to keep secrets out of committed config files. */
  apiKeyEnv: z.string().nullable().default(null).refine(
    (val) => val === null || !/^(sk-|claude-|cl-)/i.test(val),
    { message: 'apiKeyEnv must be an environment variable name, not a literal API key' },
  ),
  /** Default request timeout for all internal AI calls (ms). */
  timeoutMs: z.number().int().positive().default(30_000),
  /** Default max tokens per call. */
  maxTokens: z.number().int().positive().default(1024),
  features: AiFeaturesSchema,
  enable: AiEnableSchema,
}).default({})

const AiSchema = z.object({
  internal: AiInternalSchema,
}).default({})

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
    maxAttemptChainLength: z.number().int().min(1).max(20).default(3),
    maxRunTokens: z.number().int().min(0).default(0),
    maxIssueTokens: z.number().int().min(0).default(0),
    maxDailyTokens: z.number().int().min(0).default(0),
    maxRunWallClockMinutes: z.number().nonnegative().default(0),
    stopOnPlannerFailure: z.boolean().default(true),
    requireVerificationPass: z.boolean().default(true),
    reviewApprovalKeyword: z.string().default('APPROVED'),
    reviewNeedsChangesKeyword: z.string().default('CHANGES_REQUIRED'),
    blockOnAmbiguousReview: z.boolean().default(true),
    maxAutoRetries: z.number().int().min(0).default(3),
    maxEmptyDiffRetries: z.number().int().min(0).max(5).default(2),
    maxConsecutiveBlocks: z.number().int().min(1).max(20).default(4),
    decompose: z.boolean().default(false),
    maxSubtasks: z.number().int().min(1).max(10).default(5),
    maxConcurrentSubtasks: z.number().int().min(1).max(10).default(3),
  }).default({}),

  fileLoop: FileLoopConfigSchema.default({}),

  security: SecuritySchema.default({}),

  cost: CostSchema.default({}),

  ai: AiSchema,

  autoResolveConflicts: AutoResolveConflictsSchema,

  workerProfiles: z.record(WorkerProfileSchema).default({}),

  verificationProfiles: z.record(VerificationProfileSchema).default({}),

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
    /** Default true: only repo collaborators may run /orch commands. Set
     *  to false only for private repos where all commenters are trusted. */
    requireCollaborator: z.boolean().default(true),
  }).default({}),

  repos: z.array(RepoConfigSchema).min(1, 'At least one repository must be configured'),

  workflows: z.record(WorkflowSchema).default({}),
}).superRefine((config, ctx) => {
  const pricingModels = config.cost.pricing?.models ?? {}
  const pricingModelKeys = new Set(Object.keys(pricingModels))

  if (pricingModelKeys.size > 0) {
    const defaultModel = config.cost.pricing?.defaultModel
    if (defaultModel && !pricingModelKeys.has(defaultModel)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cost', 'pricing', 'defaultModel'],
        message: `cost.pricing.defaultModel "${defaultModel}" is not defined under cost.pricing.models.`,
      })
    }
  }

  for (const [profileName, profile] of Object.entries(config.workerProfiles)) {
    const pricingModel = profile.pricingModel
    if (!pricingModel) continue
    if (!pricingModelKeys.has(pricingModel)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workerProfiles', profileName, 'pricingModel'],
        message: `workerProfiles.${profileName}.pricingModel "${pricingModel}" is not defined in cost.pricing.models.`,
      })
    }
  }

  // Phase 3: if any ai.internal.enable.* feature is on, require
  // the provider/model/apiKeyEnv triple so the factory can build a
  // client. Otherwise the feature flag silently no-ops and callers
  // get misleading fall-through behavior.
  const aiInternal = config.ai.internal
  const anyEnabled =
    aiInternal.enable.triage ||
    aiInternal.enable.reviewerParseFallback ||
    aiInternal.enable.prBody
  if (anyEnabled) {
    if (!aiInternal.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ai', 'internal', 'provider'],
        message: 'ai.internal.provider is required when any ai.internal.enable.* flag is set',
      })
    }
    if (!aiInternal.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ai', 'internal', 'model'],
        message: 'ai.internal.model is required when any ai.internal.enable.* flag is set',
      })
    }
    if (!aiInternal.apiKeyEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ai', 'internal', 'apiKeyEnv'],
        message: 'ai.internal.apiKeyEnv is required when any ai.internal.enable.* flag is set',
      })
    }
  }
})

/**
 * Per-repo project config (`.night-orch.yml/.yaml`) loaded from inside a
 * repository checkout. Keys mirror repo-scoped config blocks plus optional
 * project-local workflow/profile definitions.
 *
 * Values are intentionally typed as `unknown` here so loader-level deep-merge
 * can preserve partial overrides without schema defaults mutating omitted
 * siblings. The merged result is then fully validated by `ConfigSchema`.
 */
export const ProjectConfigSchema = z.object({
  forge: z.unknown().optional(),
  linkedProjects: z.unknown().optional(),
  apiBaseUrl: z.unknown().optional(),
  tokenEnv: z.unknown().optional(),
  maxConcurrentRuns: z.unknown().optional(),
  baseBranch: z.unknown().optional(),
  branchPrefix: z.unknown().optional(),
  updateStrategy: z.unknown().optional(),
  labels: z.unknown().optional(),
  kanban: z.unknown().optional(),
  labelConfig: z.unknown().optional(),
  defaults: z.unknown().optional(),
  environment: z.unknown().optional(),
  verify: z.unknown().optional(),
  verificationProfile: z.unknown().optional(),
  prompts: z.unknown().optional(),
  planning: z.unknown().optional(),
  fileLoop: z.unknown().optional(),
  selectors: z.unknown().optional(),
  agents: z.unknown().optional(),
  workflow: z.unknown().optional(),
  workflowByTriage: z.unknown().optional(),
  mergeQueue: z.unknown().optional(),
  workflows: z.unknown().optional(),
  workerProfiles: z.unknown().optional(),
  verificationProfiles: z.unknown().optional(),
}).strict()

export type Config = z.infer<typeof ConfigSchema>
export type RepoConfig = z.infer<typeof RepoConfigSchema>
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>
export type CostModel = z.infer<typeof CostModelSchema>
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>
export type FileLoopConfig = z.infer<typeof FileLoopConfigSchema>
export type RepoFileLoopConfig = z.infer<typeof RepoFileLoopConfigSchema>
export type VerificationProfile = z.infer<typeof VerificationProfileSchema>
export type VerificationStage = z.infer<typeof VerificationStageSchema>
