/**
 * Extract the first JSON block from a markdown-fenced code block.
 * Looks for ```json ... ``` patterns.
 */
export function extractJsonBlock(raw: string): unknown | null {
  const pattern = /```json\s*\n([\s\S]*?)\n\s*```/
  const match = raw.match(pattern)
  if (!match?.[1]) return null

  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

/**
 * Try to parse the entire string as JSON, or extract from fences.
 */
export function parseJsonFromOutput(raw: string): unknown | null {
  // Try full string first
  try {
    return JSON.parse(raw)
  } catch {
    // Fall through
  }

  // Try fenced block
  return extractJsonBlock(raw)
}

/**
 * Extract content between markers.
 */
export function extractMarkedSection(
  raw: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const startIdx = raw.indexOf(startMarker)
  if (startIdx === -1) return null
  const contentStart = startIdx + startMarker.length
  const endIdx = raw.indexOf(endMarker, contentStart)
  if (endIdx === -1) return null
  return raw.slice(contentStart, endIdx).trim()
}
