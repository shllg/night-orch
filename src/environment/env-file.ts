import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../utils/logger.js'
import { parsePortRange, allocatePort } from './port.js'

const MARKER_START = '# --- night-orch overrides ---'
const MARKER_END = '# --- end night-orch overrides ---'

/**
 * Copy base .env and apply overrides with marked section.
 * Inspired by the Vendis bin/worktree pattern.
 */
export function setupEnvFile(params: {
  worktreePath: string
  repoLocalPath: string
  copyFrom: string
  overrides: Record<string, string>
  overrideFiles: string[]
  usedPorts: number[]
}): { envOverrides: Record<string, string>; allocatedPort: number | null } {
  const { worktreePath, repoLocalPath, copyFrom, overrides, overrideFiles, usedPorts } = params
  const targetEnv = join(worktreePath, '.env')

  // 1. Copy base .env
  const baseEnv = join(repoLocalPath, copyFrom)
  if (existsSync(baseEnv)) {
    copyFileSync(baseEnv, targetEnv)
    logger.debug({ from: baseEnv, to: targetEnv }, 'Copied base .env')
  }

  // 2. Apply additional override files
  for (const overrideFile of overrideFiles) {
    const filePath = join(repoLocalPath, overrideFile)
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8')
      appendToFile(targetEnv, content)
    }
  }

  // 3. Process overrides — resolve {auto:min-max} tokens
  let allocatedPort: number | null = null
  const resolvedOverrides: Record<string, string> = {}

  for (const [key, value] of Object.entries(overrides)) {
    const portRange = parsePortRange(value)
    if (portRange) {
      allocatedPort = allocatePort(portRange, usedPorts)
      resolvedOverrides[key] = String(allocatedPort)
    } else {
      resolvedOverrides[key] = value
    }
  }

  // 4. Write overrides in marked section
  if (Object.keys(resolvedOverrides).length > 0) {
    const overrideLines = Object.entries(resolvedOverrides)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')

    const section = `\n${MARKER_START}\n${overrideLines}\n${MARKER_END}\n`

    // Remove existing marked section if present, then append
    if (existsSync(targetEnv)) {
      let content = readFileSync(targetEnv, 'utf-8')
      const startIdx = content.indexOf(MARKER_START)
      const endIdx = content.indexOf(MARKER_END)
      if (startIdx !== -1 && endIdx !== -1) {
        content = content.slice(0, startIdx) + content.slice(endIdx + MARKER_END.length)
      }
      writeFileSync(targetEnv, content + section, 'utf-8')
    } else {
      writeFileSync(targetEnv, section, 'utf-8')
    }

    logger.debug({ overrides: resolvedOverrides }, 'Applied .env overrides')
  }

  return { envOverrides: resolvedOverrides, allocatedPort }
}

function appendToFile(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8')
    writeFileSync(filePath, existing + '\n' + content, 'utf-8')
  } else {
    writeFileSync(filePath, content, 'utf-8')
  }
}
