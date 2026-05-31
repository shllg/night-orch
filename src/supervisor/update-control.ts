import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { nowUtcIso } from '../utils/time.js'

export interface PublicUpdateStatus {
  state: string
  error?: string
  installMethod?: 'git' | 'npm'
  startedAt?: string
  previousCommit?: string
  targetCommit?: string
}

export function resolveNightOrchDataDir(): string {
  return resolve(homedir(), '.config', 'night-orch')
}

export function resolveUpdateStatusPath(dataDir: string = resolveNightOrchDataDir()): string {
  return resolve(dataDir, 'update-status.json')
}

export function resolveUpdateTriggerPath(dataDir: string = resolveNightOrchDataDir()): string {
  return resolve(dataDir, 'update-requested')
}

export async function readPublicUpdateStatus(
  statusPath: string = resolveUpdateStatusPath(),
): Promise<PublicUpdateStatus> {
  try {
    const parsed = JSON.parse(await readFile(statusPath, 'utf-8')) as Record<string, unknown>
    const status: PublicUpdateStatus = {
      state: typeof parsed['state'] === 'string' ? parsed['state'] : 'idle',
    }
    if (typeof parsed['error'] === 'string') status.error = parsed['error']
    if (parsed['installMethod'] === 'git' || parsed['installMethod'] === 'npm') {
      status.installMethod = parsed['installMethod']
    }
    if (typeof parsed['startedAt'] === 'string') status.startedAt = parsed['startedAt']
    if (typeof parsed['previousCommit'] === 'string') status.previousCommit = parsed['previousCommit']
    if (typeof parsed['targetCommit'] === 'string') status.targetCommit = parsed['targetCommit']
    return status
  } catch {
    return { state: 'idle' }
  }
}

export async function requestUpdateViaTriggerFile(
  dataDir: string = resolveNightOrchDataDir(),
): Promise<{ accepted: true; method: 'trigger-file' }> {
  const triggerPath = resolveUpdateTriggerPath(dataDir)
  await mkdir(dataDir, { recursive: true })
  await writeFile(triggerPath, nowUtcIso())
  return { accepted: true, method: 'trigger-file' }
}
