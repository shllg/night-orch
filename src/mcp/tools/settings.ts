import type { MCPDependencies } from '../server.js'
import {
  clearRuntimeSettingOverride,
  listRuntimeSettings,
  setRuntimeSettingOverride,
} from '../../settings/runtime.js'
import { assertMcpMutationAuth } from './auth.js'

function formatRuntimeSettingValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return '[function]'
  return JSON.stringify(value)
}

export async function handleListSettings(deps: MCPDependencies): Promise<unknown> {
  return {
    settings: listRuntimeSettings(deps.config, deps.db),
  }
}

export async function handleSetSetting(
  args: { key: string; value: unknown; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  if (typeof args.key !== 'string' || args.key.trim().length === 0) {
    throw new Error('key is required')
  }

  const result = setRuntimeSettingOverride(
    deps.config,
    deps.db,
    args.key.trim(),
    args.value,
    'mcp',
  )

  return {
    changed: result.changed,
    setting: result.setting,
    message: result.changed
      ? `Updated ${result.setting.key} to ${formatRuntimeSettingValue(result.setting.effectiveValue)}`
      : `${result.setting.key} unchanged`,
  }
}

export async function handleClearSetting(
  args: { key: string; authToken?: string },
  deps: MCPDependencies,
): Promise<unknown> {
  assertMcpMutationAuth(args.authToken, deps)

  if (typeof args.key !== 'string' || args.key.trim().length === 0) {
    throw new Error('key is required')
  }

  const result = clearRuntimeSettingOverride(deps.config, deps.db, args.key.trim())
  return {
    changed: result.changed,
    setting: result.setting,
    message: result.changed
      ? `Cleared override for ${result.setting.key}`
      : `No override found for ${result.setting.key}`,
  }
}
