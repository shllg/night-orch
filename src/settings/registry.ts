import type { Config } from '../config/schema.js'

export type SettingKey =
  | 'github.pollIntervalSeconds'
  | 'security.maxDailyCostUsd'
  | 'security.maxCostPerRunUsd'
  | 'loop.maxReviewIterations'
  | 'loop.maxTotalAgentPasses'
  | 'observability.agentStreaming'

export type SettingValue = number | boolean
export type SettingType = 'number' | 'boolean'

interface SettingDefinitionBase<K extends SettingKey, V extends SettingValue> {
  key: K
  label: string
  description: string
  details: string
  type: SettingType
  defaultValue: V
  yamlPath: readonly [string, ...string[]]
  read: (config: Config) => V
  apply: (config: Config, value: V) => Config
  parseInput: (raw: unknown) => V
  parseStored: (raw: string) => V
  serialize: (value: V) => string
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

export type SettingDefinition = NumberSettingDefinition | BooleanSettingDefinition

export interface SettingYamlValue {
  hasYamlValue: boolean
  yamlValue: SettingValue | null
}

const SETTING_DEFINITIONS: Record<SettingKey, SettingDefinition> = {
  'github.pollIntervalSeconds': {
    key: 'github.pollIntervalSeconds',
    label: 'Poll Interval (seconds)',
    description: 'Delay between automatic poll cycles.',
    details: 'Controls how often night-orch checks configured repos for work. Lower values react faster but increase API traffic; higher values reduce background load.',
    type: 'number',
    defaultValue: 300,
    yamlPath: ['github', 'pollIntervalSeconds'],
    min: 5,
    max: 3600,
    step: 5,
    read: (config) => config.github.pollIntervalSeconds,
    apply: (config, value) => ({
      ...config,
      github: {
        ...config.github,
        pollIntervalSeconds: value,
      },
    }),
    parseInput: (raw) => parseNumberInput(raw, {
      key: 'github.pollIntervalSeconds',
      integer: true,
      min: 5,
      max: 3600,
    }),
    parseStored: (raw) => parseStoredNumber(raw, {
      key: 'github.pollIntervalSeconds',
      integer: true,
      min: 5,
      max: 3600,
    }),
    serialize: (value) => JSON.stringify(value),
  },
  'security.maxDailyCostUsd': {
    key: 'security.maxDailyCostUsd',
    label: 'Daily Cost Budget (USD)',
    description: 'Maximum allowed spend per UTC day before new runs are blocked.',
    details: 'Sets the global daily spend cap for pay-per-use mode. When the cap is reached, new runs are blocked until the next UTC day or until you raise the limit.',
    type: 'number',
    defaultValue: 50,
    yamlPath: ['security', 'maxDailyCostUsd'],
    min: 1,
    max: 10000,
    step: 1,
    read: (config) => config.security.maxDailyCostUsd,
    apply: (config, value) => ({
      ...config,
      security: {
        ...config.security,
        maxDailyCostUsd: value,
      },
    }),
    parseInput: (raw) => parseNumberInput(raw, {
      key: 'security.maxDailyCostUsd',
      integer: false,
      min: 1,
      max: 10000,
    }),
    parseStored: (raw) => parseStoredNumber(raw, {
      key: 'security.maxDailyCostUsd',
      integer: false,
      min: 1,
      max: 10000,
    }),
    serialize: (value) => JSON.stringify(value),
  },
  'security.maxCostPerRunUsd': {
    key: 'security.maxCostPerRunUsd',
    label: 'Per-Run Cost Budget (USD)',
    description: 'Maximum allowed spend for a single run before it is blocked.',
    details: 'Sets the per-issue run cost ceiling. Useful for preventing one expensive issue from consuming most of the daily budget.',
    type: 'number',
    defaultValue: 10,
    yamlPath: ['security', 'maxCostPerRunUsd'],
    min: 0.1,
    max: 1000,
    step: 0.5,
    read: (config) => config.security.maxCostPerRunUsd,
    apply: (config, value) => ({
      ...config,
      security: {
        ...config.security,
        maxCostPerRunUsd: value,
      },
    }),
    parseInput: (raw) => parseNumberInput(raw, {
      key: 'security.maxCostPerRunUsd',
      integer: false,
      min: 0.1,
      max: 1000,
    }),
    parseStored: (raw) => parseStoredNumber(raw, {
      key: 'security.maxCostPerRunUsd',
      integer: false,
      min: 0.1,
      max: 1000,
    }),
    serialize: (value) => JSON.stringify(value),
  },
  'loop.maxReviewIterations': {
    key: 'loop.maxReviewIterations',
    label: 'Max Review Iterations',
    description: 'Maximum review correction loops per run.',
    details: 'Limits how many review-fix-review cycles a run can execute before stopping. Higher values can improve completion rate, but may increase runtime and cost.',
    type: 'number',
    defaultValue: 4,
    yamlPath: ['loop', 'maxReviewIterations'],
    min: 1,
    max: 20,
    step: 1,
    read: (config) => config.loop.maxReviewIterations,
    apply: (config, value) => ({
      ...config,
      loop: {
        ...config.loop,
        maxReviewIterations: value,
      },
    }),
    parseInput: (raw) => parseNumberInput(raw, {
      key: 'loop.maxReviewIterations',
      integer: true,
      min: 1,
      max: 20,
    }),
    parseStored: (raw) => parseStoredNumber(raw, {
      key: 'loop.maxReviewIterations',
      integer: true,
      min: 1,
      max: 20,
    }),
    serialize: (value) => JSON.stringify(value),
  },
  'loop.maxTotalAgentPasses': {
    key: 'loop.maxTotalAgentPasses',
    label: 'Max Total Agent Passes',
    description: 'Hard cap on planner/coder/reviewer passes in one run.',
    details: 'Caps total planner/coder/reviewer passes across the full run. This is a safety guard against long loops and runaway spend.',
    type: 'number',
    defaultValue: 10,
    yamlPath: ['loop', 'maxTotalAgentPasses'],
    min: 1,
    max: 50,
    step: 1,
    read: (config) => config.loop.maxTotalAgentPasses,
    apply: (config, value) => ({
      ...config,
      loop: {
        ...config.loop,
        maxTotalAgentPasses: value,
      },
    }),
    parseInput: (raw) => parseNumberInput(raw, {
      key: 'loop.maxTotalAgentPasses',
      integer: true,
      min: 1,
      max: 50,
    }),
    parseStored: (raw) => parseStoredNumber(raw, {
      key: 'loop.maxTotalAgentPasses',
      integer: true,
      min: 1,
      max: 50,
    }),
    serialize: (value) => JSON.stringify(value),
  },
  'observability.agentStreaming': {
    key: 'observability.agentStreaming',
    label: 'Agent Streaming',
    description: 'Enable in-flight agent event streaming to TUI/Web.',
    details: 'Turns live agent event streaming on or off for terminal and web views. Disable this if you want quieter live output while runs are active.',
    type: 'boolean',
    defaultValue: true,
    yamlPath: ['observability', 'agentStreaming'],
    read: (config) => config.observability?.agentStreaming ?? true,
    apply: (config, value) => ({
      ...config,
      observability: {
        ...buildDefaultObservability(config),
        agentStreaming: value,
      },
    }),
    parseInput: (raw) => parseBooleanInput(raw, 'observability.agentStreaming'),
    parseStored: (raw) => parseStoredBoolean(raw, 'observability.agentStreaming'),
    serialize: (value) => JSON.stringify(value),
  },
}

const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[]

export function listSettingDefinitions(): SettingDefinition[] {
  return SETTING_KEYS.map((key) => SETTING_DEFINITIONS[key])
}

export function getSettingDefinition(key: string): SettingDefinition | null {
  return SETTING_DEFINITIONS[key as SettingKey] ?? null
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

function parseNumberInput(
  raw: unknown,
  options: { key: SettingKey; integer: boolean; min: number; max: number },
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
  options: { key: SettingKey; integer: boolean; min: number; max: number },
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
  options: { key: SettingKey; integer: boolean; min: number; max: number },
): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${options.key} must be a finite number`)
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${options.key} must be an integer`)
  }

  if (value < options.min || value > options.max) {
    throw new Error(`${options.key} must be between ${options.min} and ${options.max}`)
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

function parseBooleanInput(raw: unknown, key: SettingKey): boolean {
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

function parseStoredBoolean(raw: string, key: SettingKey): boolean {
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

function buildDefaultObservability(config: Config): Config['observability'] {
  return {
    agentStreaming: config.observability?.agentStreaming ?? true,
    eventRetention: config.observability?.eventRetention ?? 1000,
    sessionLogs: config.observability?.sessionLogs ?? true,
    sessionLogRetention: config.observability?.sessionLogRetention ?? 7,
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
