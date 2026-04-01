import pino from 'pino'

export function createLogger(
  level = 'info',
  options: { destination?: 'stdout' | 'stderr'; pretty?: boolean } = {},
): pino.Logger {
  const dest = options.destination ?? 'stderr'
  const pretty = options.pretty ?? true
  const fd = dest === 'stderr' ? 2 : 1
  const isTTY = dest === 'stderr' ? process.stderr.isTTY : process.stdout.isTTY

  if (pretty && isTTY) {
    return pino({
      level,
      redact: {
        paths: ['*.token', '*.apiKey', '*.secret', '*.password', 'headers.authorization'],
        censor: '[REDACTED]',
      },
      transport: { target: 'pino-pretty', options: { colorize: true, destination: fd } },
    })
  }

  return pino(
    {
      level,
      redact: {
        paths: ['*.token', '*.apiKey', '*.secret', '*.password', 'headers.authorization'],
        censor: '[REDACTED]',
      },
    },
    pino.destination(fd),
  )
}

export const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info')
