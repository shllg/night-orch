/**
 * Dynamic import wrapper for acpx session-runtime functions.
 *
 * acpx bundles its session-runtime module with a content-hashed filename
 * (e.g., session-BtpTC2pM.js) and doesn't provide a stable re-export.
 * This module finds the hashed file dynamically at runtime.
 */

import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

interface AcpxSessionRuntime {
  runOnce: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>
  sendSessionDirect: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>
}

let cached: AcpxSessionRuntime | null = null

/**
 * Dynamically resolve and import acpx session-runtime functions.
 * Caches the result after first successful load.
 */
export async function loadAcpxRuntime(): Promise<AcpxSessionRuntime> {
  if (cached) return cached

  const require = createRequire(import.meta.url)
  const acpxMain = require.resolve('acpx')
  const distDir = dirname(acpxMain)

  // Find the hashed session-*.js file
  const files = await readdir(distDir)
  const sessionFile = files.find((f) => f.startsWith('session-') && f.endsWith('.js'))
  if (!sessionFile) {
    throw new Error('Could not find acpx session-runtime module in dist/')
  }

  // Use pathToFileURL for Windows compatibility — path.join produces backslash
  // paths which ESM import() rejects as ERR_UNSUPPORTED_ESM_URL_SCHEME.
  const mod = await import(pathToFileURL(join(distDir, sessionFile)).href) as Record<string, unknown>

  // The exports are minified — find runOnce and sendSessionDirect by scanning
  // exported functions. They have distinctive parameter patterns we can identify
  // by name in the non-minified source, or we use the known export names.
  const runOnce = (mod['runOnce'] ?? mod['a']) as AcpxSessionRuntime['runOnce'] | undefined
  const sendSessionDirect = (mod['sendSessionDirect'] ?? mod['s']) as AcpxSessionRuntime['sendSessionDirect'] | undefined

  if (!runOnce || !sendSessionDirect) {
    throw new Error('Could not find runOnce/sendSessionDirect exports in acpx session-runtime')
  }

  cached = { runOnce, sendSessionDirect }
  return cached
}
