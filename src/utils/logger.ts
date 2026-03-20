import pino from 'pino'

export function createLogger(level = 'info'): pino.Logger {
  return pino({
    level,
    redact: {
      paths: ['*.token', '*.apiKey', '*.secret', '*.password', 'headers.authorization'],
      censor: '[REDACTED]',
    },
    transport:
      process.stdout.isTTY
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  })
}

export const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info')
