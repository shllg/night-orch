import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { resolveProjectRoot } from './project-root.js'

export type InstallMethod = 'git' | 'npm' | 'unknown'

/** Detects whether night-orch was installed via git clone or npm global install. */
export function detectInstallMethod(): InstallMethod {
  const root = resolveProjectRoot()
  if (existsSync(resolve(root, '.git'))) return 'git'
  if (root.includes(`${sep}node_modules${sep}`)) return 'npm'
  return 'unknown'
}
