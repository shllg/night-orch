import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | null = null

/**
 * Resolves the night-orch package root directory.
 *
 * Works for both git clones and npm global installs by computing the path
 * relative to the compiled JS module location (`dist/utils/project-root.js` -> `../..`).
 */
export function resolveProjectRoot(): string {
  if (!cached) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    if (!existsSync(resolve(root, 'package.json'))) {
      throw new Error(
        `Could not locate night-orch package root (expected package.json at ${root}). ` +
        'This usually means the dist/ structure has changed.',
      )
    }
    cached = root
  }
  return cached
}
