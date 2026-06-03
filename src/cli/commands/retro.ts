import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'

type DatabaseHandle = Database.Database
import { initDatabase } from '../../state/db.js'
import { runRetro, listRecentSuggestions } from '../../ops/retro.js'
import { getSuggestion, markSuggestionApplied } from '../../state/retro.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
}

export interface RetroCommandOptions {
  since?: string
  classifier?: string
  dryRun?: boolean
  view?: string
  apply?: string
  limit?: string
}

const DEFAULT_SINCE_DAYS = 7

export async function retroCommand(opts: RetroCommandOptions, globalOpts?: GlobalOpts): Promise<void> {
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
  try {
    if (opts.view) {
      handleView(db, parseSuggestionId(opts.view))
      return
    }
    if (opts.apply) {
      handleApply(db, parseSuggestionId(opts.apply))
      return
    }
    await handleRun(db, opts)
  } finally {
    db.close()
  }
}

function handleView(db: DatabaseHandle, id: number): void {
  const suggestion = getSuggestion(db, id)
  if (!suggestion) {
    process.stderr.write(`Suggestion not found: ${id}\n`)
    process.exit(1)
  }
  console.log(`\n[suggestion ${suggestion.id}] ${suggestion.classifier}`)
  console.log(`  template: ${suggestion.targetTemplatePath}`)
  console.log(`  generated: ${suggestion.generatedAt.toISOString()}`)
  console.log(`  source runs: ${suggestion.sourceRunIds.join(', ')}`)
  console.log(`  applied: ${suggestion.appliedAt?.toISOString() ?? 'no'}`)
  console.log('')
  console.log(suggestion.suggestionMd)
}

function handleApply(db: DatabaseHandle, id: number): void {
  const suggestion = getSuggestion(db, id)
  if (!suggestion) {
    process.stderr.write(`Suggestion not found: ${id}\n`)
    process.exit(1)
  }
  // Apply policy: write a patch file under .night-orch/retro/ for the
  // operator to `git apply` and commit manually. Never auto-write to the
  // template. See ADR 0002 — no-auto-apply rationale.
  const dir = join(process.cwd(), '.night-orch', 'retro')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.md`)
  writeFileSync(path, suggestion.suggestionMd, 'utf-8')
  markSuggestionApplied(db, id)
  console.log(`\nWrote suggestion ${id} to ${path}`)
  console.log(`Target template: ${suggestion.targetTemplatePath}`)
  console.log(`Review the suggestion, edit the template manually, and commit.`)
}

async function handleRun(
  db: DatabaseHandle,
  opts: RetroCommandOptions,
): Promise<void> {
  const sinceMs = opts.since
    ? Date.parse(opts.since)
    : Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000

  if (opts.since && !Number.isFinite(sinceMs)) {
    process.stderr.write(`Invalid --since timestamp: ${opts.since} (expected ISO 8601)\n`)
    process.exit(1)
  }

  const result = await runRetro(db, {
    sinceMs,
    classifierFilter: opts.classifier,
    dryRun: opts.dryRun ?? false,
  })

  console.log(`\nnight-orch retro: scanned ${result.scanned} classifiers since ${new Date(sinceMs).toISOString()}\n`)
  if (result.clusters.length === 0) {
    console.log('  no clusters found in window')
  } else {
    console.log('Clusters:')
    for (const cluster of result.clusters) {
      console.log(`  [${cluster.count}x] ${cluster.classifier}  phase=${cluster.recentPhase}  runs=${cluster.sourceRunIds.length}`)
    }
  }

  if (opts.dryRun) {
    console.log(`\n(dry-run — no suggestions written)`)
  } else if (result.suggestionsWritten.length > 0) {
    console.log('\nSuggestions written:')
    for (const s of result.suggestionsWritten) {
      console.log(`  [#${s.id}] ${s.classifier} -> ${s.targetTemplatePath}`)
    }
    console.log(`\nView with: night-orch retro --view <id>`)
  }

  // Recent suggestions context — handy after a run to remind the operator
  // about prior unactioned items.
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 5
  if (Number.isFinite(limit) && limit > 0) {
    const recent = listRecentSuggestions(db, { limit })
    if (recent.length > 0) {
      console.log('\nMost recent suggestions:')
      for (const s of recent) {
        const applied = s.appliedAt ? '[applied]' : '[open]'
        console.log(`  ${applied} [#${s.id}] ${s.classifier} -> ${s.targetTemplatePath}`)
      }
    }
  }
}

function parseSuggestionId(raw: string): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`Invalid suggestion id: ${raw}\n`)
    process.exit(1)
  }
  return n
}
