import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { LabelsInitEngine, formatLabelsInitSummary } from '../../ops/labels-init.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

export async function labelsInitCommand(targetRepo?: string, globalOpts?: GlobalOpts): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false

  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`)
      if (err.details) err.details.forEach((d) => process.stderr.write(`${d}\n`))
    } else {
      process.stderr.write(`${(err as Error).message}\n`)
    }
    process.exitCode = 1
    return
  }

  try {
    const engine = new LabelsInitEngine(config)
    const result = await engine.run({ targetRepo, dryRun })

    for (const repoResult of result.repos) {
      if (repoResult.skipped) {
        process.stdout.write(`Skipping ${repoResult.repo}: ${repoResult.skipReason}\n`)
        continue
      }

      process.stdout.write(`Bootstrapping ${repoResult.labelsTotal} labels for ${repoResult.repo}\n`)

      if (dryRun) {
        for (const command of repoResult.dryRunCommands) {
          process.stdout.write(`[dry-run] ${command}\n`)
        }
      }

      for (const error of repoResult.errors) {
        process.stderr.write(`Failed ${repoResult.repo} label "${error.label}": ${error.message}\n`)
      }
    }

    process.stdout.write(`${formatLabelsInitSummary(result)}\n`)

    if (result.failures > 0) {
      process.exitCode = 1
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exitCode = 1
  }
}
