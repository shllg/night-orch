import { homedir } from 'node:os'
import { resolve } from 'node:path'

/**
 * Expand ~ and $ENV_VAR references in a path string.
 * Throws if a referenced env var is not set.
 */
export function expandPath(input: string): string {
  let result = input

  // Expand ~ at start
  if (result.startsWith('~/') || result === '~') {
    result = result.replace('~', homedir())
  }

  // Expand $VAR and ${VAR}
  result = result.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (_match, braced, plain) => {
    const varName = (braced ?? plain) as string
    const value = process.env[varName]
    if (value === undefined) {
      throw new Error(`Environment variable ${varName} is not set (referenced in path: ${input})`)
    }
    return value
  })

  return resolve(result)
}
