import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { initDatabase } from '../../state/db.js'
import { listHandoffs } from '../../state/handoffs.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
}

export async function handoffsCommand(runId: string, globalOpts?: GlobalOpts): Promise<void> {
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
    const handoffs = listHandoffs(db, runId)

    console.log(`\nnight-orch handoffs: ${runId}\n`)
    if (handoffs.length === 0) {
      console.log('  none')
      return
    }

    for (const handoff of handoffs) {
      const fromRole = handoff.fromRole ?? '-'
      const toRole = handoff.toRole ?? '-'
      console.log(`[${handoff.id}] ${handoff.kind}  ${handoff.stepId}  ${fromRole} -> ${toRole}`)
      console.log(`    ${handoff.summary}`)
      for (const line of markdownPreview(handoff.contentMd)) {
        console.log(`    ${line}`)
      }
      console.log('')
    }
  } finally {
    db.close()
  }
}

function markdownPreview(markdown: string): string[] {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const preview = lines.slice(0, 2)
  if (lines.length > preview.length) {
    preview.push('...')
  }
  return preview
}
