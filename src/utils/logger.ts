import pino from 'pino'

export function createLogger(
  level = 'info',
  options: { destination?: 'stdout' | 'stderr'; pretty?: boolean } = {},
): pino.Logger {
  const destination = options.destination ?? 'stdout'
  const pretty = options.pretty ?? true
  const stream = destination === 'stderr' ? pino.destination(2) : undefined

  return pino(
    {
      level,
      redact: {
        paths: ['*.token', '*.apiKey', '*.secret', '*.password', 'headers.authorization'],
        censor: '[REDACTED]',
      },
      transport:
        !stream && pretty && process.stdout.isTTY
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    stream,
  )
}

export const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info')
