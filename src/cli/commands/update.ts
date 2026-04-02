import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync, mkdirSync } from 'node:fs'

export async function updateCommand(globalOpts?: { dryRun?: boolean }): Promise<void> {
  const dryRun = globalOpts?.dryRun ?? false
  const dataDir = resolve(homedir(), '.config', 'night-orch')

  // If running under supervisor (IPC channel available), send message
  if (typeof process.send === 'function') {
    if (dryRun) {
      process.stdout.write('Would send update request to supervisor via IPC\n')
      return
    }
    process.send({ type: 'update-requested' })
    process.stdout.write('Update request sent to supervisor.\n')
    return
  }

  // Fallback: create trigger file for supervisor to pick up
  const triggerPath = resolve(dataDir, 'update-requested')
  if (dryRun) {
    process.stdout.write(`Would create trigger file at ${triggerPath}\n`)
    return
  }

  mkdirSync(dataDir, { recursive: true })
  writeFileSync(triggerPath, new Date().toISOString())
  process.stdout.write(
    `Update trigger written to ${triggerPath}\n` +
    'The supervisor will pick this up and start the update.\n',
  )
}
