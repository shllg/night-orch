import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_VERSION = '0.1.0'
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i

export interface BuildInfo {
  version: string
  gitSha: string | null
}

let cachedBuildInfo: BuildInfo | null = null

export function getBuildInfo(): BuildInfo {
  if (cachedBuildInfo) {
    return cachedBuildInfo
  }

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

  cachedBuildInfo = {
    version: readPackageVersion(projectRoot) ?? DEFAULT_VERSION,
    gitSha: readGitSha(projectRoot),
  }

  return cachedBuildInfo
}

function readPackageVersion(projectRoot: string): string | null {
  try {
    const raw = readFileSync(resolve(projectRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version !== 'string') {
      return null
    }
    const version = parsed.version.trim()
    return version.length > 0 ? version : null
  } catch {
    return null
  }
}

function readGitSha(projectRoot: string): string | null {
  const envSha = normalizeSha(process.env.NIGHT_ORCH_GIT_SHA)
  if (envSha) {
    return envSha
  }

  try {
    const sha = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return normalizeSha(sha)
  } catch {
    return null
  }
}

function normalizeSha(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim().toLowerCase()
  return SHA_PATTERN.test(normalized) ? normalized : null
}
