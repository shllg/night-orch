import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { setDailyCostCapOverride } from '../../ops/daily-cost-override.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  logLevel?: string
}

interface DailyCostOverrideCommandOpts extends GlobalOpts {
  clear?: boolean
}

export async function dailyCostOverrideCommand(
  amount: string | undefined,
  globalOpts?: DailyCostOverrideCommandOpts,
): Promise<void> {
  const clear = globalOpts?.clear ?? false
  let overrideUsd: number | null
  if (clear) {
    if (amount !== undefined) {
      console.error('Cannot pass <amount> together with --clear')
      process.exitCode = 1
      return
    }
    overrideUsd = null
  } else {
    if (amount === undefined) {
      console.error('Missing <amount>. Pass an amount in USD or use --clear to remove the override.')
      process.exitCode = 1
      return
    }
    const parsed = Number.parseFloat(amount)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`Invalid amount: ${amount}. Must be a positive number (USD).`)
      process.exitCode = 1
      return
    }
    overrideUsd = parsed
  }

  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error: ${err.message}`)
    } else {
      console.error((err as Error).message)
    }
    process.exitCode = 1
    return
  }

  const db = initDatabase(config.storage.dbPath)

  try {
    const result = setDailyCostCapOverride(db, overrideUsd)
    if (overrideUsd === null) {
      console.log(
        `Cleared daily cost cap override for ${result.date}. ` +
          `Previous: ${formatMaybeUsd(result.previousUsd)}. ` +
          `Base cap from config/settings will apply.`,
      )
    } else {
      console.log(
        `Set daily cost cap override for ${result.date} to $${overrideUsd.toFixed(2)}. ` +
          `Previous: ${formatMaybeUsd(result.previousUsd)}. ` +
          `Auto-expires at 00:00 UTC.`,
      )
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  } finally {
    db.close()
  }
}

function formatMaybeUsd(value: number | null): string {
  return value === null ? 'none' : `$${value.toFixed(2)}`
}
