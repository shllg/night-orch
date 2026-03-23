import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { RunManager } from '../../state/runs.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  logLevel?: string
}

export async function statusCommand(globalOpts?: GlobalOpts): Promise<void> {
  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`)
    } else {
      process.stderr.write(`${(err as Error).message}\n`)
    }
    process.exit(1)
  }

  const db = initDatabase(config.storage.dbPath)
  const runs = new RunManager(db)

  const active = runs.getActive()
  const recent = db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 20")
    .all() as RawRow[]

  const activeLeases = db
    .prepare("SELECT * FROM leases WHERE leased_until > datetime('now')")
    .all() as LeaseRow[]

  const dailyCost = db
    .prepare("SELECT SUM(estimated_cost_usd) as total FROM runs WHERE date(created_at) = date('now')")
    .get() as { total: number | null } | undefined

  // Header
  console.log('\n  night-orch status\n')

  // Active runs
  if (active.length === 0) {
    console.log('  Active runs:  none')
  } else {
    console.log('  Active runs:')
    for (const run of active) {
      const duration = run.startedAt ? timeSince(run.startedAt) : '?'
      console.log(`    ${statusIcon(run.status)} ${run.repo}#${run.issueNumber}  ${run.status}/${run.currentPhase ?? '?'}  iter=${run.iterationCount}  ${duration}  ${run.id}`)
    }
  }

  // Active leases
  if (activeLeases.length > 0) {
    console.log(`\n  Active leases: ${activeLeases.length}`)
    for (const l of activeLeases) {
      console.log(`    ${l.repo}#${l.issue_number}  owner=${l.lease_owner}  expires=${l.leased_until}`)
    }
  }

  // Daily cost
  const cost = dailyCost?.total ?? 0
  const budget = config.security.maxDailyCostUsd
  const costPct = budget > 0 ? Math.round((cost / budget) * 100) : 0
  console.log(`\n  Daily cost:   $${cost.toFixed(2)} / $${budget.toFixed(2)} (${costPct}%)`)

  // Recent runs
  console.log('\n  Recent runs:')
  console.log('  %-14s %-24s %6s %-10s %-8s %7s  %s'.replace(/%/g, ' '))
  console.log(`  ${'ID'.padEnd(14)} ${'Repo#Issue'.padEnd(24)} ${'Status'.padEnd(10)} ${'Phase'.padEnd(8)} ${'Iter'.padStart(4)} ${'Cost'.padStart(7)}  ${'Duration/Error'}`)
  console.log(`  ${'─'.repeat(14)} ${'─'.repeat(24)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(4)} ${'─'.repeat(7)}  ${'─'.repeat(30)}`)

  for (const row of recent) {
    const id = row.id.replace('run-', '')
    const repoIssue = `${row.repo}#${row.issue_number}`
    const status = row.status
    const phase = row.current_phase ?? '-'
    const iter = String(row.iteration_count ?? 0)
    const cost = `$${(row.estimated_cost_usd ?? 0).toFixed(2)}`
    const detail = row.last_error
      ? row.last_error.slice(0, 40)
      : row.started_at && row.ended_at
        ? formatDuration(row.started_at, row.ended_at)
        : row.started_at
          ? timeSince(row.started_at)
          : '-'

    console.log(`  ${statusIcon(status)} ${id.padEnd(12)} ${repoIssue.padEnd(24)} ${status.padEnd(10)} ${phase.padEnd(8)} ${iter.padStart(4)} ${cost.padStart(7)}  ${detail}`)
  }

  // Configured repos
  console.log(`\n  Configured repos: ${config.repos.map((r) => r.repo).join(', ')}`)
  console.log(`  Poll interval:    ${config.github.pollIntervalSeconds}s`)
  console.log(`  Metrics:          ${config.metrics.enabled ? `http://${config.metrics.host}:${config.metrics.port}/metrics` : 'disabled'}`)
  console.log('')

  db.close()
}

function statusIcon(status: string): string {
  switch (status) {
    case 'running': return '\x1b[33m●\x1b[0m'
    case 'queued': return '\x1b[36m○\x1b[0m'
    case 'completed': return '\x1b[32m✓\x1b[0m'
    case 'error': return '\x1b[31m✗\x1b[0m'
    case 'blocked': return '\x1b[31m■\x1b[0m'
    case 'review_ready': return '\x1b[35m◆\x1b[0m'
    default: return ' '
  }
}

function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime()
  return formatMs(ms) + ' ago'
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return formatMs(ms)
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

interface RawRow {
  id: string
  repo: string
  issue_number: number
  status: string
  current_phase: string | null
  iteration_count: number | null
  estimated_cost_usd: number | null
  started_at: string | null
  ended_at: string | null
  last_error: string | null
}

interface LeaseRow {
  repo: string
  issue_number: number
  lease_owner: string
  leased_until: string
}
