import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { setIssueCostOverride } from '../../ops/cost-override.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  logLevel?: string
}

interface CostOverrideCommandOpts extends GlobalOpts {
  clear?: boolean
}

export async function costOverrideCommand(
  repo: string,
  issueNumber: string,
  amount: string | undefined,
  globalOpts?: CostOverrideCommandOpts,
): Promise<void> {
  const num = Number.parseInt(issueNumber, 10)
  if (!Number.isFinite(num) || num <= 0) {
    console.error(`Invalid issue number: ${issueNumber}`)
    process.exitCode = 1
    return
  }

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
    const result = setIssueCostOverride(db, repo, num, overrideUsd)
    if (overrideUsd === null) {
      console.log(
        `Cleared cost override for ${repo}#${num} (run ${result.runId}). ` +
          `Previous: ${formatMaybeUsd(result.previousOverrideUsd)}`,
      )
    } else {
      console.log(
        `Set cost override for ${repo}#${num} (run ${result.runId}) to $${overrideUsd.toFixed(2)}. ` +
          `Previous: ${formatMaybeUsd(result.previousOverrideUsd)}. ` +
          `This run will now bypass the daily cap and use $${overrideUsd.toFixed(2)} as its per-run cap.`,
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
