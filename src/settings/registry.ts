import { z } from 'zod'
import {
  AppMentionSchema,
  CostPricingModelSchema,
  NotificationChannelSchema,
  type Config,
  WorkerProfileSchema,
  WorkflowSchema,
} from '../config/schema.js'

export type SettingKey = string
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }
export type SettingValue = JsonValue
export type SettingType = 'number' | 'boolean' | 'string' | 'json'

type SettingPath = readonly [string, ...string[]]

interface SettingDefinitionBase<K extends SettingKey, V extends SettingValue> {
  key: K
  label: string
  description: string
  details: string
  type: SettingType
  mutable: boolean
  sensitive: boolean
  defaultValue: V | null
  yamlPath: SettingPath
  read: (config: Config) => V
  apply: (config: Config, value: V) => Config
  parseInput: (raw: unknown) => V
  parseStored: (raw: string) => V
  serialize: (value: V) => string
  sanitizeForDisplay: (value: V) => SettingValue
}

export interface NumberSettingDefinition<K extends SettingKey = SettingKey>
  extends SettingDefinitionBase<K, number> {
  type: 'number'
  min?: number
  max?: number
  step?: number
}

export interface BooleanSettingDefinition<K extends SettingKey = SettingKey>
  extends SettingDefinitionBase<K, boolean> {
  type: 'boolean'
}

export interface StringSettingDefinition<K extends SettingKey = SettingKey>
  extends SettingDefinitionBase<K, string | null> {
  type: 'string'
  options?: readonly string[]
  allowNull?: boolean
}

export interface JsonSettingDefinition<K extends SettingKey = SettingKey>
  extends SettingDefinitionBase<K, JsonValue> {
  type: 'json'
}

export type SettingDefinition =
  | NumberSettingDefinition
  | BooleanSettingDefinition
  | StringSettingDefinition
  | JsonSettingDefinition

export interface SettingYamlValue {
  hasYamlValue: boolean
  yamlValue: SettingValue | null
}

const SETTING_DEFINITIONS: Record<string, SettingDefinition> = buildSettingDefinitions()
const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS)

export function listSettingDefinitions(): SettingDefinition[] {
  return SETTING_KEYS.map((key) => SETTING_DEFINITIONS[key]!)
}

export function getSettingDefinition(key: string): SettingDefinition | null {
  return SETTING_DEFINITIONS[key] ?? null
}

export function sanitizeSettingValueForDisplay(
  definition: SettingDefinition,
  value: SettingValue | null,
): SettingValue | null {
  if (value === null) {
    return null
  }
  const sanitize = definition.sanitizeForDisplay as (input: SettingValue) => SettingValue
  return sanitize(value)
}

export function resolveSettingYamlValue(
  definition: SettingDefinition,
  rawConfig: unknown,
  baseConfig: Config,
): SettingYamlValue {
  if (!hasValueAtPath(rawConfig, definition.yamlPath)) {
    return {
      hasYamlValue: false,
      yamlValue: null,
    }
  }

  return {
    hasYamlValue: true,
    yamlValue: definition.read(baseConfig),
  }
}

const GithubAppMentionsOverrideSchema = z.record(AppMentionSchema)
const NotificationsChannelsOverrideSchema = z.array(NotificationChannelSchema)
const CostPricingModelsOverrideSchema = z.record(CostPricingModelSchema)
const WorkerProfilesOverrideSchema = z.record(WorkerProfileSchema)
const WorkflowsOverrideSchema = z.record(WorkflowSchema)

function buildSettingDefinitions(): Record<string, SettingDefinition> {
  const definitions: SettingDefinition[] = [
    stringSetting({
      key: 'github.tokenEnv',
      label: 'GitHub Token Env Var',
      description: 'Environment variable name used for GitHub authentication.',
      details: 'Set the env var name that stores the GitHub token. This must be a variable name, not a literal token value.',
      defaultValue: null,
      yamlPath: ['github', 'tokenEnv'],
      minLength: 1,
      validate: (value) => {
        if (value.startsWith('ghp_') || value.startsWith('ghs_') || value.startsWith('github_pat_')) {
          return 'github.tokenEnv should be an environment variable name, not a literal token'
        }
        return null
      },
    }),
    stringSetting({
      key: 'github.apiBaseUrl',
      label: 'GitHub API Base URL',
      description: 'Base URL for GitHub API requests.',
      details: 'Override the API base URL used for GitHub repos. Useful for GitHub Enterprise deployments.',
      defaultValue: 'https://api.github.com',
      yamlPath: ['github', 'apiBaseUrl'],
      minLength: 1,
      url: true,
    }),
    numberSetting({
      key: 'github.pollIntervalSeconds',
      label: 'Poll Interval (seconds)',
      description: 'Delay between automatic poll cycles.',
      details: 'Controls how often night-orch checks configured repos for work. Lower values react faster but increase API traffic.',
      defaultValue: 300,
      yamlPath: ['github', 'pollIntervalSeconds'],
      integer: true,
      min: 5,
      max: 3600,
      step: 5,
    }),
    jsonSetting({
      key: 'github.appMentions',
      label: 'GitHub App Mentions',
      description: 'Mention template map used for app-trigger comments.',
      details: 'Record keyed by mention alias with enabled flag and comment template payloads.',
      defaultValue: {},
      yamlPath: ['github', 'appMentions'],
      normalize: (value) => validateJsonSettingShape(value, GithubAppMentionsOverrideSchema, 'github.appMentions'),
    }),

    stringSetting({
      key: 'storage.dbPath',
      label: 'State DB Path',
      description: 'SQLite database file path.',
      details: 'Location of the runtime state database file. Read-only at runtime because DB opens before overrides are loaded.',
      defaultValue: '~/.config/night-orch/state.db',
      yamlPath: ['storage', 'dbPath'],
      minLength: 1,
      mutable: false,
    }),
    stringSetting({
      key: 'storage.worktreeRoot',
      label: 'Worktree Root',
      description: 'Root directory used for issue worktrees.',
      details: 'Base path where dedicated issue worktrees are created.',
      defaultValue: '~/code/.night-orch/worktrees',
      yamlPath: ['storage', 'worktreeRoot'],
      minLength: 1,
    }),
    stringSetting({
      key: 'storage.logsRoot',
      label: 'Logs Root',
      description: 'Root directory used for run/session logs.',
      details: 'Base path where runtime log files are written.',
      defaultValue: '~/code/.night-orch/logs',
      yamlPath: ['storage', 'logsRoot'],
      minLength: 1,
    }),
    booleanSetting({
      key: 'storage.autoCleanup.enabled',
      label: 'Auto Cleanup Enabled',
      description: 'Enable periodic cleanup jobs.',
      details: 'When enabled, stale worktrees and old logs are cleaned up automatically on schedule.',
      defaultValue: true,
      yamlPath: ['storage', 'autoCleanup', 'enabled'],
    }),
    numberSetting({
      key: 'storage.autoCleanup.intervalMinutes',
      label: 'Auto Cleanup Interval (minutes)',
      description: 'How often automatic cleanup runs.',
      details: 'Interval between automatic cleanup runs.',
      defaultValue: 60,
      yamlPath: ['storage', 'autoCleanup', 'intervalMinutes'],
      integer: true,
      min: 1,
      step: 5,
    }),
    numberSetting({
      key: 'storage.retention.worktreeAgeDays',
      label: 'Worktree Retention (days)',
      description: 'Retention window for stale worktrees.',
      details: 'Completed/error worktrees older than this threshold may be removed during cleanup.',
      defaultValue: 7,
      yamlPath: ['storage', 'retention', 'worktreeAgeDays'],
      integer: true,
      min: 1,
      step: 1,
    }),
    numberSetting({
      key: 'storage.retention.detailDays',
      label: 'Detail Retention (days)',
      description: 'Retention window for detailed run data.',
      details: 'Detailed run artifacts are retained for this many days before archival/cleanup.',
      defaultValue: 30,
      yamlPath: ['storage', 'retention', 'detailDays'],
      integer: true,
      min: 1,
      step: 1,
    }),
    numberSetting({
      key: 'storage.retention.archiveDays',
      label: 'Archive Retention (days)',
      description: 'Retention window for archived run data.',
      details: 'Archived records older than this threshold can be removed.',
      defaultValue: 90,
      yamlPath: ['storage', 'retention', 'archiveDays'],
      integer: true,
      min: 1,
      step: 1,
    }),

    jsonSetting({
      key: 'notifications.channels',
      label: 'Notification Channels',
      description: 'Configured notification channel list.',
      details: 'Array of notification channel definitions (console/webhook/discord/smtp).',
      defaultValue: [{ type: 'console' }],
      yamlPath: ['notifications', 'channels'],
      normalize: (value) => validateJsonSettingShape(value, NotificationsChannelsOverrideSchema, 'notifications.channels'),
    }),

    booleanSetting({
      key: 'notifications.events.onRunStarted',
      label: 'Notify: Run Started',
      description: 'Send notifications when runs start.',
      details: 'Controls whether run-started notifications are dispatched.',
      defaultValue: false,
      yamlPath: ['notifications', 'events', 'onRunStarted'],
    }),
    booleanSetting({
      key: 'notifications.events.onBlocked',
      label: 'Notify: Blocked',
      description: 'Send notifications when runs become blocked.',
      details: 'Controls whether blocked-run notifications are dispatched.',
      defaultValue: true,
      yamlPath: ['notifications', 'events', 'onBlocked'],
    }),
    booleanSetting({
      key: 'notifications.events.onPrReady',
      label: 'Notify: PR Ready',
      description: 'Send notifications when PRs are ready.',
      details: 'Controls whether ready-for-review PR notifications are dispatched.',
      defaultValue: true,
      yamlPath: ['notifications', 'events', 'onPrReady'],
    }),
    booleanSetting({
      key: 'notifications.events.onPrUpdated',
      label: 'Notify: PR Updated',
      description: 'Send notifications when PRs are updated.',
      details: 'Controls whether PR update notifications are dispatched.',
      defaultValue: true,
      yamlPath: ['notifications', 'events', 'onPrUpdated'],
    }),
    booleanSetting({
      key: 'notifications.events.onError',
      label: 'Notify: Error',
      description: 'Send notifications on orchestration errors.',
      details: 'Controls whether error notifications are dispatched.',
      defaultValue: true,
      yamlPath: ['notifications', 'events', 'onError'],
    }),
    booleanSetting({
      key: 'notifications.events.onRetryExhausted',
      label: 'Notify: Retry Exhausted',
      description: 'Send notifications when retries are exhausted.',
      details: 'Controls whether retry-exhausted notifications are dispatched.',
      defaultValue: true,
      yamlPath: ['notifications', 'events', 'onRetryExhausted'],
    }),

    numberSetting({
      key: 'loop.maxReviewIterations',
      label: 'Max Review Iterations',
      description: 'Maximum review correction loops per run.',
      details: 'Limits how many review-fix-review cycles a run can execute before stopping.',
      defaultValue: 4,
      yamlPath: ['loop', 'maxReviewIterations'],
      integer: true,
      min: 1,
      step: 1,
    }),
    numberSetting({
      key: 'loop.maxTotalAgentPasses',
      label: 'Max Total Agent Passes',
      description: 'Hard cap on planner/coder/reviewer passes in one run.',
      details: 'Caps total planner/coder/reviewer passes across the full run.',
      defaultValue: 10,
      yamlPath: ['loop', 'maxTotalAgentPasses'],
      integer: true,
      min: 1,
      step: 1,
    }),
    booleanSetting({
      key: 'loop.stopOnPlannerFailure',
      label: 'Stop On Planner Failure',
      description: 'Stop run when planner output fails validation.',
      details: 'If enabled, planner failure ends the run early instead of proceeding.',
      defaultValue: true,
      yamlPath: ['loop', 'stopOnPlannerFailure'],
    }),
    booleanSetting({
      key: 'loop.requireVerificationPass',
      label: 'Require Verification Pass',
      description: 'Require verify commands to pass before completion.',
      details: 'If enabled, failed verification blocks completion.',
      defaultValue: true,
      yamlPath: ['loop', 'requireVerificationPass'],
    }),
    stringSetting({
      key: 'loop.reviewApprovalKeyword',
      label: 'Review Approval Keyword',
      description: 'Reviewer keyword interpreted as approval.',
      details: 'Expected keyword emitted by reviewer agent for approval.',
      defaultValue: 'APPROVED',
      yamlPath: ['loop', 'reviewApprovalKeyword'],
      minLength: 1,
    }),
    stringSetting({
      key: 'loop.reviewNeedsChangesKeyword',
      label: 'Review Needs-Changes Keyword',
      description: 'Reviewer keyword interpreted as changes required.',
      details: 'Expected keyword emitted by reviewer agent for change requests.',
      defaultValue: 'CHANGES_REQUIRED',
      yamlPath: ['loop', 'reviewNeedsChangesKeyword'],
      minLength: 1,
    }),
    booleanSetting({
      key: 'loop.blockOnAmbiguousReview',
      label: 'Block On Ambiguous Review',
      description: 'Block run if review output is ambiguous.',
      details: 'If enabled, unparseable reviewer output results in blocked status.',
      defaultValue: true,
      yamlPath: ['loop', 'blockOnAmbiguousReview'],
    }),
    numberSetting({
      key: 'loop.maxAutoRetries',
      label: 'Max Auto Retries',
      description: 'Automatic retry attempts for infrastructure failures.',
      details: 'Maximum number of automatic retries after transient failures.',
      defaultValue: 3,
      yamlPath: ['loop', 'maxAutoRetries'],
      integer: true,
      min: 0,
      step: 1,
    }),
    booleanSetting({
      key: 'loop.decompose',
      label: 'Enable Decomposition',
      description: 'Allow issue decomposition into sub-tasks.',
      details: 'If enabled, eligible issues can be split into dependent sub-tasks.',
      defaultValue: false,
      yamlPath: ['loop', 'decompose'],
    }),
    numberSetting({
      key: 'loop.maxSubtasks',
      label: 'Max Subtasks',
      description: 'Maximum sub-tasks per decomposition.',
      details: 'Upper bound for generated decomposition sub-tasks.',
      defaultValue: 5,
      yamlPath: ['loop', 'maxSubtasks'],
      integer: true,
      min: 1,
      max: 10,
      step: 1,
    }),
    numberSetting({
      key: 'loop.maxConcurrentSubtasks',
      label: 'Max Concurrent Subtasks',
      description: 'Maximum parallel sub-task executions.',
      details: 'Upper bound for concurrently running sub-task worktrees.',
      defaultValue: 3,
      yamlPath: ['loop', 'maxConcurrentSubtasks'],
      integer: true,
      min: 1,
      max: 10,
      step: 1,
    }),

    numberSetting({
      key: 'security.maxChangedFiles',
      label: 'Max Changed Files',
      description: 'Diff guard threshold for changed files.',
      details: 'Runs are blocked when changed-file count exceeds this threshold.',
      defaultValue: 50,
      yamlPath: ['security', 'maxChangedFiles'],
      integer: true,
      min: 1,
      step: 1,
    }),
    numberSetting({
      key: 'security.maxChangedLines',
      label: 'Max Changed Lines',
      description: 'Diff guard threshold for changed lines.',
      details: 'Runs are blocked when changed-line count exceeds this threshold.',
      defaultValue: 5000,
      yamlPath: ['security', 'maxChangedLines'],
      integer: true,
      min: 1,
      step: 50,
    }),
    numberSetting({
      key: 'security.maxDailyCostUsd',
      label: 'Daily Cost Budget (USD)',
      description: 'Maximum allowed spend per UTC day before new runs are blocked.',
      details: 'Sets the global daily spend cap for pay-per-use mode.',
      defaultValue: 50,
      yamlPath: ['security', 'maxDailyCostUsd'],
      integer: false,
      min: 0.01,
      step: 1,
    }),
    numberSetting({
      key: 'security.maxCostPerRunUsd',
      label: 'Per-Run Cost Budget (USD)',
      description: 'Maximum allowed spend for a single run before it is blocked.',
      details: 'Sets the per-issue run cost ceiling for pay-per-use mode.',
      defaultValue: 10,
      yamlPath: ['security', 'maxCostPerRunUsd'],
      integer: false,
      min: 0.01,
      step: 0.5,
    }),

    stringSetting({
      key: 'cost.model',
      label: 'Cost Model',
      description: 'Cost enforcement model.',
      details: 'pay-per-use enforces spend caps; subscription treats USD as advisory.',
      defaultValue: 'pay-per-use',
      yamlPath: ['cost', 'model'],
      options: ['pay-per-use', 'subscription'],
    }),
    stringSetting({
      key: 'cost.pricing.defaultModel',
      label: 'Default Pricing Model',
      description: 'Fallback model key for pricing lookups.',
      details: 'Used when a worker profile does not specify a pricing model.',
      defaultValue: 'default',
      yamlPath: ['cost', 'pricing', 'defaultModel'],
      minLength: 1,
    }),
    jsonSetting({
      key: 'cost.pricing.models',
      label: 'Pricing Models Map',
      description: 'Model-specific pricing table.',
      details: 'Record keyed by model name with token/minute pricing values.',
      defaultValue: {},
      yamlPath: ['cost', 'pricing', 'models'],
      normalize: (value) => validateJsonSettingShape(value, CostPricingModelsOverrideSchema, 'cost.pricing.models'),
    }),

    jsonSetting({
      key: 'workerProfiles',
      label: 'Worker Profiles',
      description: 'Global worker profile definitions.',
      details: 'Record of worker profile definitions keyed by profile name.',
      defaultValue: {},
      yamlPath: ['workerProfiles'],
      sensitive: true,
      normalize: (value) => validateJsonSettingShape(value, WorkerProfilesOverrideSchema, 'workerProfiles'),
      sanitizeForDisplay: (value) => redactWorkerProfiles(value),
    }),

    booleanSetting({
      key: 'metrics.enabled',
      label: 'Metrics Enabled',
      description: 'Enable Prometheus metrics export.',
      details: 'Turns `/metrics` export on or off.',
      defaultValue: true,
      yamlPath: ['metrics', 'enabled'],
    }),
    numberSetting({
      key: 'metrics.port',
      label: 'Metrics Port',
      description: 'TCP port for Prometheus metrics endpoint.',
      details: 'Port used when metrics exporter is enabled.',
      defaultValue: 9090,
      yamlPath: ['metrics', 'port'],
      integer: true,
      min: 1,
      max: 65535,
      step: 1,
    }),
    stringSetting({
      key: 'metrics.host',
      label: 'Metrics Host',
      description: 'Bind address for Prometheus metrics endpoint.',
      details: 'Network interface/address used by metrics exporter.',
      defaultValue: '0.0.0.0',
      yamlPath: ['metrics', 'host'],
      minLength: 1,
    }),

    booleanSetting({
      key: 'observability.agentStreaming',
      label: 'Agent Streaming',
      description: 'Enable in-flight agent event streaming to TUI/Web.',
      details: 'Turns live agent event streaming on or off for terminal and web views.',
      defaultValue: true,
      yamlPath: ['observability', 'agentStreaming'],
    }),
    numberSetting({
      key: 'observability.eventRetention',
      label: 'Event Retention',
      description: 'Maximum in-memory event backlog per run/session.',
      details: 'Controls event retention window for stream history.',
      defaultValue: 1000,
      yamlPath: ['observability', 'eventRetention'],
      integer: true,
      min: 100,
      max: 10000,
      step: 100,
    }),
    booleanSetting({
      key: 'observability.sessionLogs',
      label: 'Session Logs Enabled',
      description: 'Persist interactive agent session logs to disk.',
      details: 'If enabled, interactive session logs are written and retained.',
      defaultValue: true,
      yamlPath: ['observability', 'sessionLogs'],
    }),
    numberSetting({
      key: 'observability.sessionLogRetention',
      label: 'Session Log Retention (days)',
      description: 'Retention period for interactive session logs.',
      details: 'Session logs older than this many days may be deleted by cleanup.',
      defaultValue: 7,
      yamlPath: ['observability', 'sessionLogRetention'],
      integer: true,
      min: 1,
      step: 1,
    }),

    booleanSetting({
      key: 'mcp.enabled',
      label: 'MCP Enabled',
      description: 'Enable MCP server exposure.',
      details: 'Turns MCP server availability on or off for applicable commands/modes.',
      defaultValue: false,
      yamlPath: ['mcp', 'enabled'],
    }),
    stringSetting({
      key: 'mcp.transport',
      label: 'MCP Transport',
      description: 'Transport protocol used by MCP server.',
      details: 'Currently only stdio transport is supported.',
      defaultValue: 'stdio',
      yamlPath: ['mcp', 'transport'],
      options: ['stdio'],
    }),
    stringSetting({
      key: 'mcp.authTokenEnv',
      label: 'MCP Auth Token Env Var',
      description: 'Optional env var name containing MCP mutation auth token.',
      details: 'Set to null (or clear in YAML) to disable MCP mutation token checks.',
      defaultValue: null,
      yamlPath: ['mcp', 'authTokenEnv'],
      allowNull: true,
      minLength: 1,
    }),
    numberSetting({
      key: 'mcp.httpPort',
      label: 'MCP HTTP Port',
      description: 'TCP port for embedded MCP HTTP transport.',
      details: 'Port used when running embedded MCP HTTP/SSE mode.',
      defaultValue: 3100,
      yamlPath: ['mcp', 'httpPort'],
      integer: true,
      min: 1,
      max: 65535,
      step: 1,
    }),
    stringSetting({
      key: 'mcp.httpHost',
      label: 'MCP HTTP Host',
      description: 'Bind address for embedded MCP HTTP transport.',
      details: 'Network interface/address used for MCP HTTP endpoint binding.',
      defaultValue: '127.0.0.1',
      yamlPath: ['mcp', 'httpHost'],
      minLength: 1,
    }),

    booleanSetting({
      key: 'commentCommands.enabled',
      label: 'Comment Commands Enabled',
      description: 'Enable issue comment command processing.',
      details: 'If enabled, `/orch` comment commands are parsed and processed.',
      defaultValue: true,
      yamlPath: ['commentCommands', 'enabled'],
    }),
    booleanSetting({
      key: 'commentCommands.requireCollaborator',
      label: 'Require Collaborator For Commands',
      description: 'Require collaborator permission for comment commands.',
      details: 'When enabled, only collaborators can run issue comment commands.',
      defaultValue: true,
      yamlPath: ['commentCommands', 'requireCollaborator'],
    }),
    jsonSetting({
      key: 'workflows',
      label: 'Workflow Definitions',
      description: 'Named workflow definitions.',
      details: 'Record of named workflow graphs (steps/roles/agents) used by workflow selection.',
      defaultValue: {},
      yamlPath: ['workflows'],
      normalize: (value) => validateJsonSettingShape(value, WorkflowsOverrideSchema, 'workflows'),
    }),
  ]

  const entries = new Map<string, SettingDefinition>()
  for (const definition of definitions) {
    if (entries.has(definition.key)) {
      throw new Error(`Duplicate runtime setting key: ${definition.key}`)
    }
    entries.set(definition.key, definition)
  }

  return Object.fromEntries(entries)
}

interface NumberSettingOptions {
  key: string
  label: string
  description: string
  details: string
  defaultValue: number
  yamlPath: SettingPath
  integer: boolean
  min?: number
  max?: number
  step?: number
  mutable?: boolean
  sensitive?: boolean
  sanitizeForDisplay?: (value: number) => SettingValue
}

function numberSetting(options: NumberSettingOptions): NumberSettingDefinition {
  return {
    key: options.key,
    label: options.label,
    description: options.description,
    details: options.details,
    type: 'number',
    mutable: options.mutable ?? true,
    sensitive: options.sensitive ?? false,
    defaultValue: options.defaultValue,
    yamlPath: options.yamlPath,
    ...(options.min !== undefined ? { min: options.min } : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.step !== undefined ? { step: options.step } : {}),
    read: (config) => readNumberValue(config, options.yamlPath, options.defaultValue),
    apply: (config, value) => setConfigValue(config, options.yamlPath, value),
    parseInput: (raw) => parseNumberInput(raw, {
      key: options.key,
      integer: options.integer,
      min: options.min,
      max: options.max,
    }),
    parseStored: (raw) => parseStoredNumber(raw, {
      key: options.key,
      integer: options.integer,
      min: options.min,
      max: options.max,
    }),
    serialize: (value) => JSON.stringify(value),
    sanitizeForDisplay: options.sanitizeForDisplay ?? identitySanitize,
  }
}

interface BooleanSettingOptions {
  key: string
  label: string
  description: string
  details: string
  defaultValue: boolean
  yamlPath: SettingPath
  mutable?: boolean
  sensitive?: boolean
  sanitizeForDisplay?: (value: boolean) => SettingValue
}

function booleanSetting(options: BooleanSettingOptions): BooleanSettingDefinition {
  return {
    key: options.key,
    label: options.label,
    description: options.description,
    details: options.details,
    type: 'boolean',
    mutable: options.mutable ?? true,
    sensitive: options.sensitive ?? false,
    defaultValue: options.defaultValue,
    yamlPath: options.yamlPath,
    read: (config) => readBooleanValue(config, options.yamlPath, options.defaultValue),
    apply: (config, value) => setConfigValue(config, options.yamlPath, value),
    parseInput: (raw) => parseBooleanInput(raw, options.key),
    parseStored: (raw) => parseStoredBoolean(raw, options.key),
    serialize: (value) => JSON.stringify(value),
    sanitizeForDisplay: options.sanitizeForDisplay ?? identitySanitize,
  }
}

interface StringSettingOptions {
  key: string
  label: string
  description: string
  details: string
  defaultValue: string | null
  yamlPath: SettingPath
  options?: readonly string[]
  allowNull?: boolean
  minLength?: number
  url?: boolean
  validate?: (value: string) => string | null
  mutable?: boolean
  sensitive?: boolean
  sanitizeForDisplay?: (value: string | null) => SettingValue
}

function stringSetting(options: StringSettingOptions): StringSettingDefinition {
  return {
    key: options.key,
    label: options.label,
    description: options.description,
    details: options.details,
    type: 'string',
    mutable: options.mutable ?? true,
    sensitive: options.sensitive ?? false,
    defaultValue: options.defaultValue,
    yamlPath: options.yamlPath,
    ...(options.options ? { options: options.options } : {}),
    ...(options.allowNull ? { allowNull: true } : {}),
    read: (config) => readStringValue(config, options.yamlPath, options.defaultValue, options.allowNull ?? false),
    apply: (config, value) => setConfigValue(config, options.yamlPath, value),
    parseInput: (raw) => parseStringInput(raw, {
      key: options.key,
      allowNull: options.allowNull,
      options: options.options,
      minLength: options.minLength,
      url: options.url,
      validate: options.validate,
    }),
    parseStored: (raw) => parseStoredString(raw, {
      key: options.key,
      allowNull: options.allowNull,
      options: options.options,
      minLength: options.minLength,
      url: options.url,
      validate: options.validate,
    }),
    serialize: (value) => JSON.stringify(value),
    sanitizeForDisplay: options.sanitizeForDisplay ?? identitySanitize,
  }
}

interface JsonSettingOptions {
  key: string
  label: string
  description: string
  details: string
  defaultValue: JsonValue
  yamlPath: SettingPath
  mutable?: boolean
  sensitive?: boolean
  normalize?: (value: JsonValue) => JsonValue
  sanitizeForDisplay?: (value: JsonValue) => SettingValue
}

function jsonSetting(options: JsonSettingOptions): JsonSettingDefinition {
  return {
    key: options.key,
    label: options.label,
    description: options.description,
    details: options.details,
    type: 'json',
    mutable: options.mutable ?? true,
    sensitive: options.sensitive ?? false,
    defaultValue: options.defaultValue,
    yamlPath: options.yamlPath,
    read: (config) => readJsonValue(config, options.yamlPath, options.defaultValue),
    apply: (config, value) => setConfigValue(config, options.yamlPath, value),
    parseInput: (raw) => {
      const parsed = parseJsonInput(raw, options.key)
      return options.normalize ? options.normalize(parsed) : parsed
    },
    parseStored: (raw) => {
      const parsed = parseStoredJson(raw, options.key)
      return options.normalize ? options.normalize(parsed) : parsed
    },
    serialize: (value) => JSON.stringify(value),
    sanitizeForDisplay: options.sanitizeForDisplay ?? identitySanitize,
  }
}

function parseNumberInput(
  raw: unknown,
  options: { key: string; integer: boolean; min?: number; max?: number },
): number {
  const parsed = typeof raw === 'number'
    ? raw
    : typeof raw === 'string'
      ? parseStrictNumberString(raw)
      : Number.NaN

  return validateNumber(parsed, options)
}

function parseStoredNumber(
  raw: string,
  options: { key: string; integer: boolean; min?: number; max?: number },
): number {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'number') {
      throw new Error(`Stored value for ${options.key} is not numeric`)
    }
    return validateNumber(parsed, options)
  } catch (err) {
    throw new Error(`Invalid stored value for ${options.key}: ${(err as Error).message}`)
  }
}

function validateNumber(
  value: number,
  options: { key: string; integer: boolean; min?: number; max?: number },
): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${options.key} must be a finite number`)
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${options.key} must be an integer`)
  }

  if (options.min !== undefined && value < options.min) {
    throw new Error(`${options.key} must be >= ${options.min}`)
  }

  if (options.max !== undefined && value > options.max) {
    throw new Error(`${options.key} must be <= ${options.max}`)
  }

  return value
}

function parseStrictNumberString(raw: string): number {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return Number.NaN
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return Number.NaN
  }

  return parsed
}

function parseBooleanInput(raw: unknown, key: string): boolean {
  if (typeof raw === 'boolean') {
    return raw
  }
  if (typeof raw !== 'string') {
    throw new Error(`${key} must be true/false`)
  }

  const normalized = raw.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false
  }
  throw new Error(`${key} must be true/false`)
}

function parseStoredBoolean(raw: string, key: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'boolean') {
      throw new Error(`Stored value for ${key} is not boolean`)
    }
    return parsed
  } catch (err) {
    throw new Error(`Invalid stored value for ${key}: ${(err as Error).message}`)
  }
}

interface StringParseOptions {
  key: string
  allowNull?: boolean
  options?: readonly string[]
  minLength?: number
  url?: boolean
  validate?: (value: string) => string | null
}

function parseStringInput(raw: unknown, options: StringParseOptions): string | null {
  if (raw === null) {
    if (options.allowNull) {
      return null
    }
    throw new Error(`${options.key} must be a string`)
  }

  if (typeof raw !== 'string') {
    throw new Error(`${options.key} must be a string`)
  }

  if (options.allowNull && raw.trim().toLowerCase() === 'null') {
    return null
  }

  const value = raw

  if (options.minLength !== undefined && value.trim().length < options.minLength) {
    throw new Error(`${options.key} must be at least ${options.minLength} character(s)`)
  }

  if (options.options && !options.options.includes(value)) {
    throw new Error(`${options.key} must be one of: ${options.options.join(', ')}`)
  }

  if (options.url) {
    try {
      void new URL(value)
    } catch {
      throw new Error(`${options.key} must be a valid URL`)
    }
  }

  const validationError = options.validate?.(value)
  if (validationError) {
    throw new Error(validationError)
  }

  return value
}

function parseStoredString(raw: string, options: StringParseOptions): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'string' && parsed !== null) {
      throw new Error(`Stored value for ${options.key} is not string/null`)
    }
    return parseStringInput(parsed, options)
  } catch (err) {
    throw new Error(`Invalid stored value for ${options.key}: ${(err as Error).message}`)
  }
}

function parseJsonInput(raw: unknown, key: string): JsonValue {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isJsonValue(parsed)) {
        throw new Error('must be valid JSON')
      }
      return parsed
    } catch (err) {
      throw new Error(`${key} must be valid JSON: ${(err as Error).message}`)
    }
  }

  if (!isJsonValue(raw)) {
    throw new Error(`${key} must be valid JSON`)
  }

  return raw
}

function parseStoredJson(raw: string, key: string): JsonValue {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isJsonValue(parsed)) {
      throw new Error(`Stored value for ${key} is not valid JSON`)
    }
    return parsed
  } catch (err) {
    throw new Error(`Invalid stored value for ${key}: ${(err as Error).message}`)
  }
}

function validateJsonSettingShape<T>(value: JsonValue, schema: z.ZodType<T>, key: string): JsonValue {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data as JsonValue
  }

  const issue = result.error.issues[0]
  const path = issue?.path.length ? issue.path.join('.') : key
  const message = issue?.message ?? 'invalid structure'
  throw new Error(`${key} has invalid structure (${path}): ${message}`)
}

function identitySanitize<T extends SettingValue>(value: T): T {
  return value
}

function redactWorkerProfiles(value: JsonValue): JsonValue {
  if (!isRecord(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([profileName, profile]) => {
      if (!isRecord(profile) || !isRecord(profile['env'])) {
        return [profileName, profile]
      }

      const redactedEnv = Object.fromEntries(
        Object.keys(profile['env']).map((envKey) => [envKey, '[redacted]']),
      )
      return [profileName, { ...profile, env: redactedEnv }]
    }),
  )
}

function readNumberValue(config: Config, path: SettingPath, fallback: number): number {
  const value = readPathValue(config, path)
  return typeof value === 'number' ? value : fallback
}

function readBooleanValue(config: Config, path: SettingPath, fallback: boolean): boolean {
  const value = readPathValue(config, path)
  return typeof value === 'boolean' ? value : fallback
}

function readStringValue(
  config: Config,
  path: SettingPath,
  fallback: string | null,
  allowNull: boolean,
): string | null {
  const value = readPathValue(config, path)
  if (typeof value === 'string') {
    return value
  }
  if (allowNull && value === null) {
    return null
  }
  return fallback
}

function readJsonValue(config: Config, path: SettingPath, fallback: JsonValue): JsonValue {
  const value = readPathValue(config, path)
  return isJsonValue(value) ? value : fallback
}

function setConfigValue(config: Config, path: SettingPath, value: unknown): Config {
  return setPathValue(config, path, value) as Config
}

function readPathValue(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

function setPathValue(
  source: unknown,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) {
    return isRecord(source) ? { ...source } : {}
  }

  const [segment, ...rest] = path
  if (segment === undefined) {
    return isRecord(source) ? { ...source } : {}
  }
  const current = isRecord(source) ? source : {}

  if (rest.length === 0) {
    return {
      ...current,
      [segment]: value,
    }
  }

  return {
    ...current,
    [segment]: setPathValue(current[segment], rest, value),
  }
}

function hasValueAtPath(
  source: unknown,
  path: readonly string[],
): boolean {
  let current: unknown = source

  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) {
      return false
    }
    current = current[segment]
  }

  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry))
  }

  if (!isRecord(value)) {
    return false
  }

  return Object.values(value).every((entry) => isJsonValue(entry))
}
