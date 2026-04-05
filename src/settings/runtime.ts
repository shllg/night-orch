import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import { logger } from '../utils/logger.js'
import {
  getSettingDefinition,
  listSettingDefinitions,
  type SettingDefinition,
  type SettingKey,
  type SettingType,
  type SettingValue,
} from './registry.js'
import { SettingOverrideStore, type SettingOverrideRow } from '../state/settings.js'

export interface RuntimeSettingSnapshot {
  key: SettingKey
  label: string
  description: string
  details: string
  type: SettingType
  min?: number
  max?: number
  step?: number
  defaultValue: SettingValue
  baseValue: SettingValue
  overrideValue: SettingValue | null
  effectiveValue: SettingValue
  source: 'base' | 'override'
  updatedBy: string | null
  updatedAt: string | null
}

export interface RuntimeSettingMutationResult {
  changed: boolean
  setting: RuntimeSettingSnapshot
  effectiveConfig: Config
}

export class RuntimeSettingInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeSettingInputError'
  }
}

interface ParsedOverride {
  row: SettingOverrideRow
  definition: SettingDefinition
  value: SettingValue
}

export function listRuntimeSettings(
  baseConfig: Config,
  db: Database.Database,
): RuntimeSettingSnapshot[] {
  const parsedOverrides = parseSettingOverrides(db)

  return listSettingDefinitions().map((definition) => {
    const override = parsedOverrides.get(definition.key)
    const baseValue = definition.read(baseConfig)
    const overrideValue = override?.value ?? null
    const effectiveValue = overrideValue ?? baseValue

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      details: definition.details,
      type: definition.type,
      ...(definition.type === 'number'
        ? {
            ...(definition.min !== undefined ? { min: definition.min } : {}),
            ...(definition.max !== undefined ? { max: definition.max } : {}),
            ...(definition.step !== undefined ? { step: definition.step } : {}),
          }
        : {}),
      defaultValue: definition.defaultValue,
      baseValue,
      overrideValue,
      effectiveValue,
      source: overrideValue === null ? 'base' : 'override',
      updatedBy: override?.row.updatedBy ?? null,
      updatedAt: override?.row.updatedAt ?? null,
    }
  })
}

export function resolveConfigWithRuntimeSettings(
  baseConfig: Config,
  db: Database.Database,
): Config {
  const parsedOverrides = parseSettingOverrides(db)
  let effectiveConfig = baseConfig

  for (const definition of listSettingDefinitions()) {
    const override = parsedOverrides.get(definition.key)
    if (!override) continue
    if (definition.type === 'number') {
      if (typeof override.value !== 'number') continue
      effectiveConfig = definition.apply(effectiveConfig, override.value)
      continue
    }
    if (typeof override.value !== 'boolean') continue
    effectiveConfig = definition.apply(effectiveConfig, override.value)
  }

  return effectiveConfig
}

export function setRuntimeSettingOverride(
  baseConfig: Config,
  db: Database.Database,
  key: string,
  rawValue: unknown,
  updatedBy: string | null = null,
): RuntimeSettingMutationResult {
  const definition = requireSettingDefinition(key)
  let serialized: string
  try {
    if (definition.type === 'number') {
      const parsedValue = definition.parseInput(rawValue)
      serialized = definition.serialize(parsedValue)
    } else {
      const parsedValue = definition.parseInput(rawValue)
      serialized = definition.serialize(parsedValue)
    }
  } catch (err) {
    throw new RuntimeSettingInputError((err as Error).message)
  }
  const store = new SettingOverrideStore(db)
  const existing = store.get(definition.key)
  const changed = !existing || existing.value !== serialized

  if (changed) {
    store.upsert(definition.key, serialized, updatedBy)
  }

  const setting = listRuntimeSettings(baseConfig, db).find((entry) => entry.key === definition.key)
  if (!setting) {
    throw new Error(`Failed to resolve setting after update: ${definition.key}`)
  }

  return {
    changed,
    setting,
    effectiveConfig: resolveConfigWithRuntimeSettings(baseConfig, db),
  }
}

export function clearRuntimeSettingOverride(
  baseConfig: Config,
  db: Database.Database,
  key: string,
): RuntimeSettingMutationResult {
  const definition = requireSettingDefinition(key)
  const store = new SettingOverrideStore(db)
  const changed = store.delete(definition.key)

  const setting = listRuntimeSettings(baseConfig, db).find((entry) => entry.key === definition.key)
  if (!setting) {
    throw new Error(`Failed to resolve setting after clear: ${definition.key}`)
  }

  return {
    changed,
    setting,
    effectiveConfig: resolveConfigWithRuntimeSettings(baseConfig, db),
  }
}

function requireSettingDefinition(key: string): SettingDefinition {
  const definition = getSettingDefinition(key)
  if (!definition) {
    const available = listSettingDefinitions().map((entry) => entry.key).join(', ')
    throw new RuntimeSettingInputError(`Unknown setting key "${key}". Supported keys: ${available}`)
  }
  return definition
}

function parseSettingOverrides(db: Database.Database): Map<SettingKey, ParsedOverride> {
  const maybeDb = db as unknown as { prepare?: unknown }
  if (typeof maybeDb.prepare !== 'function') {
    return new Map()
  }

  const store = new SettingOverrideStore(db)
  let rows: SettingOverrideRow[]
  try {
    rows = store.list()
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Failed to load runtime settings overrides')
    return new Map()
  }
  const parsed = new Map<SettingKey, ParsedOverride>()

  for (const row of rows) {
    const definition = getSettingDefinition(row.key)
    if (!definition) {
      logger.warn({ key: row.key }, 'Ignoring unknown runtime setting override key')
      continue
    }

    try {
      const value = definition.parseStored(row.value)
      parsed.set(definition.key, {
        row,
        definition,
        value,
      })
    } catch (err) {
      logger.warn(
        { key: row.key, err: (err as Error).message },
        'Ignoring invalid runtime setting override value',
      )
    }
  }

  return parsed
}
