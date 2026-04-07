import type { z } from 'zod'
import type { Config } from '../config/schema.js'
import { githubDefinitions } from './definitions/github.js'
import { loopDefinitions } from './definitions/loop.js'
import { observabilityDefinitions } from './definitions/observability.js'
import { securityDefinitions } from './definitions/security.js'

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

function buildSettingDefinitions(): Record<string, SettingDefinition> {
  const definitions: SettingDefinition[] = [
    ...githubDefinitions(),
    ...loopDefinitions(),
    ...securityDefinitions(),
    ...observabilityDefinitions(),
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

// --- Builder functions (exported for use by definition modules) ---

export interface NumberSettingOptions {
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

export function numberSetting(options: NumberSettingOptions): NumberSettingDefinition {
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

export interface BooleanSettingOptions {
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

export function booleanSetting(options: BooleanSettingOptions): BooleanSettingDefinition {
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

export interface StringSettingOptions {
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

export function stringSetting(options: StringSettingOptions): StringSettingDefinition {
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

export interface JsonSettingOptions {
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

export function jsonSetting(options: JsonSettingOptions): JsonSettingDefinition {
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

export function validateJsonSettingShape<T>(value: JsonValue, schema: z.ZodType<T>, key: string): JsonValue {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data as JsonValue
  }

  const issue = result.error.issues[0]
  const path = issue?.path.length ? issue.path.join('.') : key
  const message = issue?.message ?? 'invalid structure'
  throw new Error(`${key} has invalid structure (${path}): ${message}`)
}

// --- Internal helpers ---

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

function identitySanitize<T extends SettingValue>(value: T): T {
  return value
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
