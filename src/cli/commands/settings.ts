import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import {
  clearRuntimeSettingOverride,
  listRuntimeSettings,
  setRuntimeSettingOverride,
} from '../../settings/runtime.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  logLevel?: string
}

export async function settingsListCommand(
  globalOpts?: GlobalOpts,
  json = false,
): Promise<void> {
  const resources = loadSettingsResources(globalOpts)
  if (!resources) return

  const { db, baseConfig } = resources
  try {
    const settings = listRuntimeSettings(baseConfig, db)
    if (json) {
      console.log(JSON.stringify({ settings }, null, 2))
      return
    }

    console.log('\nRuntime Settings (base + DB override)\n')
    for (const setting of settings) {
      const bounds = setting.type === 'number'
        ? `${setting.min ?? '-'}..${setting.max ?? '-'} step=${setting.step ?? '-'}`
        : 'true|false'
      const overrideDisplay = setting.overrideValue === null ? '-' : formatSettingValue(setting.overrideValue)
      const updated = setting.updatedAt ?? '-'

      console.log(`${setting.key}`)
      console.log(`  label:      ${setting.label}`)
      console.log(`  base:       ${formatSettingValue(setting.baseValue)}`)
      console.log(`  override:   ${overrideDisplay}`)
      console.log(`  effective:  ${formatSettingValue(setting.effectiveValue)} (${setting.source})`)
      console.log(`  accepted:   ${bounds}`)
      console.log(`  updated:    ${updated}`)
    }
    console.log('')
  } finally {
    db.close()
  }
}

export async function settingsSetCommand(
  key: string,
  value: string,
  globalOpts?: GlobalOpts,
): Promise<void> {
  const resources = loadSettingsResources(globalOpts)
  if (!resources) return

  const { db, baseConfig } = resources
  try {
    const result = setRuntimeSettingOverride(baseConfig, db, key, value, 'cli')
    const changedMessage = result.changed ? 'updated' : 'unchanged'
    console.log(
      `${changedMessage}: ${result.setting.key} = ${formatSettingValue(result.setting.effectiveValue)} (source=${result.setting.source})`,
    )
  } catch (err) {
    process.stderr.write(`Settings error: ${(err as Error).message}\n`)
    process.exitCode = 1
  } finally {
    db.close()
  }
}

export async function settingsUnsetCommand(
  key: string,
  globalOpts?: GlobalOpts,
): Promise<void> {
  const resources = loadSettingsResources(globalOpts)
  if (!resources) return

  const { db, baseConfig } = resources
  try {
    const result = clearRuntimeSettingOverride(baseConfig, db, key)
    const changedMessage = result.changed ? 'cleared override' : 'no override to clear'
    console.log(
      `${changedMessage}: ${result.setting.key} => ${formatSettingValue(result.setting.effectiveValue)} (source=${result.setting.source})`,
    )
  } catch (err) {
    process.stderr.write(`Settings error: ${(err as Error).message}\n`)
    process.exitCode = 1
  } finally {
    db.close()
  }
}

function loadSettingsResources(
  globalOpts?: GlobalOpts,
): { baseConfig: Awaited<ReturnType<typeof loadConfig>>; db: ReturnType<typeof initDatabase> } | null {
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    const baseConfig = loadConfig(configPath)
    const db = initDatabase(baseConfig.storage.dbPath)
    return { baseConfig, db }
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`)
      if (err.details) err.details.forEach((detail) => process.stderr.write(`${detail}\n`))
    } else {
      process.stderr.write(`${(err as Error).message}\n`)
    }
    process.exitCode = 1
    return null
  }
}

function formatSettingValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return String(value)
}
