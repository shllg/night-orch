import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { SyncEngine } from '../../ops/sync.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

export async function syncCommand(globalOpts?: GlobalOpts): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false

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
    const engine = new SyncEngine(db, config)
    const result = await engine.reconcile(dryRun)

    // Print structured results
    if (result.reconciledRuns.length > 0) {
      console.log('\nReconciled runs:')
      for (const action of result.reconciledRuns) {
        console.log(`  ${action.repo}#${action.issueNumber}: ${action.action} — ${action.reason}`)
      }
    }

    if (result.labelCorrections.length > 0) {
      console.log('\nLabel corrections:')
      for (const correction of result.labelCorrections) {
        console.log(`  ${correction.repo}#${correction.issueNumber}: ${correction.reason}`)
        if (correction.added.length > 0) console.log(`    +${correction.added.join(', ')}`)
        if (correction.removed.length > 0) console.log(`    -${correction.removed.join(', ')}`)
      }
    }

    if (result.orphanedWorktrees.length > 0) {
      console.log('\nOrphaned worktrees:')
      for (const wt of result.orphanedWorktrees) {
        console.log(`  ${wt}`)
      }
    }

    console.log(`\nSync complete: ${result.reconciledRuns.length} reconciled, ${result.expiredLeases} expired lease(s), ${result.orphanedWorktrees.length} orphaned worktree(s)`)
    if (dryRun) console.log('(dry run — no changes applied)')
  } finally {
    db.close()
  }
}
