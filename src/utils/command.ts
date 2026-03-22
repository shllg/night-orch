export interface ParsedCommand {
  binary: string
  args: string[]
}

export type CommandSpec = string | string[]

export function parseCommandSpec(spec: CommandSpec): ParsedCommand {
  if (Array.isArray(spec)) {
    const [binary, ...args] = spec
    if (!binary || binary.trim() === '') {
      throw new Error('Command array must contain at least one non-empty argument')
    }
    return { binary, args }
  }
  return parseCommandString(spec)
}

export function parseCommandString(command: string): ParsedCommand {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!

    if (escaping) {
      current += ch
      escaping = false
      continue
    }

    if (ch === '\\') {
      if (quote === "'") {
        current += ch
      } else {
        escaping = true
      }
      continue
    }

    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += ch
  }

  if (escaping) {
    current += '\\'
  }
  if (quote) {
    throw new Error(`Unterminated ${quote} quote in command: ${command}`)
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  if (tokens.length === 0) {
    throw new Error('Command cannot be empty')
  }

  return {
    binary: tokens[0]!,
    args: tokens.slice(1),
  }
}
