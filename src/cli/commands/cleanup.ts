import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { CleanupEngine } from '../../ops/cleanup.js'

interface GlobalOpts {
  config?: string
  dryRun?: boolean
  logLevel?: string
}

interface CleanupCommandOpts extends GlobalOpts {
  errorAgeDays?: number
  mergedBranches?: boolean
  logAgeDays?: number
}

export async function cleanupCommand(globalOpts?: CleanupCommandOpts): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false

  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config)
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
    const engine = new CleanupEngine(db, config)
    const result = await engine.run({
      completedWorktrees: true,
      errorWorktreeAgeDays: globalOpts?.errorAgeDays ?? 7,
      mergedBranches: globalOpts?.mergedBranches ?? false,
      logArchiveAgeDays: globalOpts?.logAgeDays ?? 30,
      dryRun,
    })

    if (result.removedWorktrees.length > 0) {
      console.log('\nRemoved worktrees:')
      for (const wt of result.removedWorktrees) {
        console.log(`  ${wt}`)
      }
    }

    if (result.removedBranches.length > 0) {
      console.log('\nRemoved branches:')
      for (const branch of result.removedBranches) {
        console.log(`  ${branch}`)
      }
    }

    if (result.archivedLogs.length > 0) {
      console.log('\nArchived logs:')
      for (const log of result.archivedLogs) {
        console.log(`  ${log}`)
      }
    }

    console.log(`\nCleanup complete: ${result.removedWorktrees.length} worktree(s), ${result.removedBranches.length} branch(es), ${result.expiredLeases} lease(s), ${result.archivedLogs.length} log(s) archived`)
    if (result.freedDiskMb > 0) {
      console.log(`Freed ~${result.freedDiskMb.toFixed(1)} MB`)
    }
    if (dryRun) console.log('(dry run — no changes applied)')
  } finally {
    db.close()
  }
}
