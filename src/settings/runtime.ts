import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import { logger } from '../utils/logger.js'
import {
  getSettingDefinition,
  listSettingDefinitions,
  sanitizeSettingValueForDisplay,
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
  mutable: boolean
  sensitive: boolean
  min?: number
  max?: number
  step?: number
  options?: string[]
  allowNull?: boolean
  defaultValue: SettingValue | null
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
    const hasOverride = override !== undefined
    const overrideValue = hasOverride ? override.value : null
    const effectiveValue = hasOverride ? override.value : baseValue
    const displayDefaultValue = sanitizeSettingValueForDisplay(definition, definition.defaultValue)
    const displayBaseValue = sanitizeSettingValueForDisplay(definition, baseValue)
    const displayOverrideValue = sanitizeSettingValueForDisplay(definition, overrideValue)
    const displayEffectiveValue = sanitizeSettingValueForDisplay(definition, effectiveValue)

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      details: definition.details,
      type: definition.type,
      mutable: definition.mutable,
      sensitive: definition.sensitive,
      ...(definition.type === 'number'
        ? {
            ...(definition.min !== undefined ? { min: definition.min } : {}),
            ...(definition.max !== undefined ? { max: definition.max } : {}),
            ...(definition.step !== undefined ? { step: definition.step } : {}),
          }
        : {}),
      ...(definition.type === 'string'
        ? {
            ...(definition.options ? { options: [...definition.options] } : {}),
            ...(definition.allowNull ? { allowNull: true } : {}),
          }
        : {}),
      defaultValue: displayDefaultValue,
      baseValue: displayBaseValue,
      overrideValue: displayOverrideValue,
      effectiveValue: displayEffectiveValue,
      source: hasOverride ? 'override' : 'base',
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
    if (definition.type === 'boolean') {
      if (typeof override.value !== 'boolean') continue
      effectiveConfig = definition.apply(effectiveConfig, override.value)
      continue
    }
    if (definition.type === 'string') {
      if (typeof override.value !== 'string' && override.value !== null) continue
      effectiveConfig = definition.apply(effectiveConfig, override.value)
      continue
    }
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
  if (!definition.mutable) {
    throw new RuntimeSettingInputError(`${definition.key} is read-only at runtime and cannot be overridden`)
  }
  let serialized: string
  try {
    if (definition.type === 'number') {
      const parsedValue = definition.parseInput(rawValue)
      serialized = definition.serialize(parsedValue)
    } else if (definition.type === 'boolean') {
      const parsedValue = definition.parseInput(rawValue)
      serialized = definition.serialize(parsedValue)
    } else if (definition.type === 'string') {
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
  if (!definition.mutable) {
    throw new RuntimeSettingInputError(`${definition.key} is read-only at runtime and cannot be overridden`)
  }
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
