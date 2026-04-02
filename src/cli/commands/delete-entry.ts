import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { DeleteIssueEntryEngine } from '../../ops/delete-entry.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

interface DeleteEntryCommandOpts extends GlobalOpts {
  force?: boolean
}

export async function deleteEntryCommand(
  repo: string,
  issueNumber: string,
  globalOpts?: DeleteEntryCommandOpts,
): Promise<void> {
  const num = parseInt(issueNumber, 10)
  if (isNaN(num)) {
    console.error(`Invalid issue number: ${issueNumber}`)
    process.exitCode = 1
    return
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
    const engine = new DeleteIssueEntryEngine(db, config)
    const result = await engine.deleteEntry(repo, num, {
      dryRun: globalOpts?.dryRun ?? false,
      force: globalOpts?.force ?? false,
    })

    if (!result.found) {
      console.log(`No local issue entry found for ${repo}#${num}`)
      if (result.dryRun) console.log('(dry run — no changes applied)')
      return
    }

    const action = result.dryRun ? 'Delete preview' : 'Deleted'
    console.log(`${action} local issue entry for ${repo}#${num}`)
    console.log(`  runs: ${result.runsDeleted}`)
    console.log(`  issues: ${result.issuesDeleted}`)
    console.log(`  issue links: ${result.issueLinksDeleted}`)
    console.log(`  leases: ${result.leasesDeleted}`)
    console.log(`  command tracking rows: ${result.commandTrackingDeleted}`)
    console.log(`  events: ${result.eventsDeleted}`)
    console.log(`  agent events: ${result.agentEventsDeleted}`)
    console.log(`  worktrees removed: ${result.worktreesRemoved.length}`)
    if (result.worktreesFailed.length > 0) {
      console.log(`  worktree cleanup warnings: ${result.worktreesFailed.length}`)
      for (const warning of result.worktreesFailed) {
        console.log(`    ${warning}`)
      }
    }
    if (result.dryRun) console.log('(dry run — no changes applied)')
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  } finally {
    db.close()
  }
}
