/**
 * Progressive JSON extraction from LLM output.
 *
 * Strategies tried in order:
 * 1. Full string as JSON
 * 2. Last fenced ```json block
 * 3. Last fenced ``` block (no language tag)
 * 4. Bare JSON object in text (greedy brace matching)
 * 5. Truncated/malformed JSON repair (close open braces/brackets)
 */

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
    // Try repairing truncated JSON from fenced block
    return repairAndParse(lastContent)
  }
}

/**
 * Extract JSON from any fenced code block (``` without language tag).
 */
function extractAnyFencedBlock(raw: string): unknown | null {
  const pattern = /```\s*\n([\s\S]*?)\n\s*```/g
  let lastContent: string | null = null
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    const content = match[1]
    if (content && content.trimStart().startsWith('{')) {
      lastContent = content
    }
  }
  if (!lastContent) return null

  try {
    return JSON.parse(lastContent)
  } catch {
    return repairAndParse(lastContent)
  }
}

/**
 * Find a bare JSON object in text by matching outermost braces.
 * Scans from the end of the string to find the last complete object.
 */
function extractBareJsonObject(raw: string): unknown | null {
  // Find the last '}' in the string
  let lastObjectEnd = -1
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] === '}') {
      lastObjectEnd = i
      break
    }
  }
  if (lastObjectEnd === -1) return null

  // Scan forward to find the matching opening brace
  let depth = 0
  let lastObjectStart = -1
  let inString = false
  let escape = false

  for (let i = 0; i <= lastObjectEnd; i++) {
    const ch = raw[i]!

    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '{') {
      if (depth === 0) {
        lastObjectStart = i
      }
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && i === lastObjectEnd) {
        break
      }
      if (depth === 0) {
        // Reset — this was a complete object before the one we want
        lastObjectStart = -1
      }
    }
  }

  if (lastObjectStart === -1 || lastObjectEnd === -1) return null

  const candidate = raw.slice(lastObjectStart, lastObjectEnd + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return repairAndParse(candidate)
  }
}

/**
 * Attempt to repair truncated JSON by closing open structures.
 * Handles common LLM failure modes:
 * - Output cut off mid-object (missing closing braces/brackets)
 * - Trailing commas before closing delimiters
 * - Unterminated strings
 */
export function repairAndParse(raw: string): unknown | null {
  let text = raw.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null

  // Strip trailing commas before we close structures
  text = text.replace(/,\s*$/, '')

  // Close unterminated strings — if odd number of unescaped quotes, add one
  const unescapedQuotes = text.match(/(?<!\\)"/g)
  if (unescapedQuotes && unescapedQuotes.length % 2 !== 0) {
    text += '"'
  }

  // Count open/close braces and brackets
  let braces = 0
  let brackets = 0
  let inStr = false
  let esc = false
  for (const ch of text) {
    if (esc) { esc = false; continue }
    if (ch === '\\' && inStr) { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
  }

  // Strip trailing comma that might appear before closing
  text = text.replace(/,\s*$/, '')

  // Close open structures
  while (brackets > 0) { text += ']'; brackets-- }
  while (braces > 0) { text += '}'; braces-- }

  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Try to parse the entire string as JSON, or progressively extract from
 * fenced blocks, bare objects, and repaired truncated output.
 *
 * Strategies (in order):
 * 1. Full string as JSON
 * 2. Last ```json fenced block
 * 3. Last ``` fenced block containing JSON
 * 4. Bare JSON object in text
 * 5. Truncated JSON repair on full string
 */
export function parseJsonFromOutput(raw: string): unknown | null {
  // Strategy 1: Full string is valid JSON
  try {
    return JSON.parse(raw)
  } catch {
    // Fall through
  }

  // Strategy 2: Last ```json block
  const fromJsonFence = extractJsonBlock(raw)
  if (fromJsonFence !== null) return fromJsonFence

  // Strategy 3: Last ``` block (no language tag)
  const fromAnyFence = extractAnyFencedBlock(raw)
  if (fromAnyFence !== null) return fromAnyFence

  // Strategy 4: Bare JSON object in text
  const fromBare = extractBareJsonObject(raw)
  if (fromBare !== null) return fromBare

  // Strategy 5: Repair truncated JSON (the whole string might be a cut-off object)
  return repairAndParse(raw)
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
