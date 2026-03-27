/**
 * Extract the last JSON block from markdown-fenced code blocks.
 * With multi-turn output, earlier turns may reference JSON examples;
 * the structured output is always the final fence.
 */
export function extractJsonBlock(raw: string): unknown | null {
  const pattern = /```json\s*\n([\s\S]*?)\n\s*```/g
  let lastContent: string | null = null
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    if (match[1]) lastContent = match[1]
  }
  if (!lastContent) return null

  try {
    return JSON.parse(lastContent)
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
