import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { LeaseManager } from '../../state/leases.js'
import { createWorktreeManager } from '../../git/worktree.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  dryRun?: boolean
  logLevel?: string
}

export async function cleanupCommand(globalOpts?: GlobalOpts): Promise<void> {
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
  const leaseManager = new LeaseManager(db)
  const worktreeManager = createWorktreeManager()

  // Clean expired leases
  const expiredLeases = leaseManager.cleanExpired()
  console.log(`Cleaned ${expiredLeases} expired lease(s)`)

  // List and optionally remove stale worktrees
  for (const repoConfig of config.repos) {
    const worktrees = await worktreeManager.list(repoConfig.localPath, config.storage.worktreeRoot)

    // Find completed/error runs and clean their worktrees
    for (const wt of worktrees) {
      const row = db
        .prepare(
          "SELECT status FROM runs WHERE worktree_path = ? AND status IN ('completed', 'error') ORDER BY created_at DESC LIMIT 1",
        )
        .get(wt.path) as { status: string } | undefined

      if (row) {
        if (dryRun) {
          console.log(`[dry-run] Would remove worktree: ${wt.path} (${wt.branchName}, status: ${row.status})`)
        } else {
          try {
            await worktreeManager.remove(wt.path, false)
            console.log(`Removed worktree: ${wt.path} (${wt.branchName})`)
          } catch (err) {
            logger.warn({ path: wt.path, err }, 'Failed to remove worktree')
          }
        }
      }
    }
  }

  db.close()
}
