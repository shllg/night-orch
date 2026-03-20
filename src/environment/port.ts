/**
 * Parse an "{auto:min-max}" port range string.
 */
export function parsePortRange(spec: string): { min: number; max: number } | null {
  const match = spec.match(/^\{auto:(\d+)-(\d+)\}$/)
  if (!match) return null
  return { min: parseInt(match[1]!, 10), max: parseInt(match[2]!, 10) }
}

/**
 * Allocate the first free port in a range, given already-used ports.
 */
export function allocatePort(range: { min: number; max: number }, usedPorts: number[]): number {
  const used = new Set(usedPorts)
  for (let port = range.min; port <= range.max; port++) {
    if (!used.has(port)) return port
  }
  throw new Error(`Port range ${range.min}-${range.max} exhausted (${usedPorts.length} in use)`)
}
