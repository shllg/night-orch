import { loadConfig } from './loader.js'
import type { ConfigError } from './loader.js'
import type { Config } from './schema.js'

export interface ReloadOutcome {
  config: Config
  reloaded: boolean
  error?: ConfigError | Error
}

/**
 * Attempt to reload a config from disk. On success the returned config is the
 * new value; on failure the original config object is returned unchanged along
 * with the underlying error. The poll loop uses this to hot-reload without
 * risking a half-applied config.
 */
export function tryReloadConfig(configPath: string, current: Config): ReloadOutcome {
  try {
    const next = loadConfig(configPath)
    return { config: next, reloaded: true }
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err))
    return { config: current, reloaded: false, error: wrapped }
  }
}
