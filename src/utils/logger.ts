import pino from 'pino'

/**
 * Paths scrubbed from every log object. Extend this list with case-sensitive
 * header names and known credential field names. `**.foo` matches `foo` at
 * any depth, but pino's path matcher is case-sensitive — so `Authorization`
 * and `authorization` must be listed separately.
 */
const REDACT_PATHS = [
  // Generic credential fields
  '**.token',
  '**.Token',
  '**.apiKey',
  '**.apikey',
  '**.ApiKey',
  '**.API_KEY',
  '**.secret',
  '**.Secret',
  '**.password',
  '**.Password',
  '**.credential',
  '**.credentials',
  '**.auth',
  '**.access_token',
  '**.accessToken',
  '**.refresh_token',
  '**.refreshToken',
  '**.privateKey',
  '**.private_key',
  // HTTP header variants — Octokit/Forgejo surface these in error objects.
  '**.authorization',
  '**.Authorization',
  '**.headers.authorization',
  '**.headers.Authorization',
  // Phase 3: Anthropic uses a non-standard auth header; pino is
  // case-sensitive so both casings need to be listed.
  '**.headers["x-api-key"]',
  '**.headers["X-Api-Key"]',
  '**["x-api-key"]',
  // Environment blobs: if a caller logs a full env snapshot, scrub it.
  'env',
  '*.env',
  '**.env',
]

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
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
      transport: { target: 'pino-pretty', options: { colorize: true, destination: fd } },
    })
  }

  return pino(
    {
      level,
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
    },
    pino.destination(fd),
  )
}

export const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info')

/**
 * Create a child logger scoped to a specific run. Binds runId, repo, and
 * issueNumber so every log entry from this run includes them automatically.
 */
export function createRunLogger(
  runId: string,
  repo: string,
  issueNumber: number,
): pino.Logger {
  return logger.child({ runId, repo, issueNumber })
}

/**
 * Create a child logger scoped to a specific loop phase within a run.
 */
export function createPhaseLogger(
  parent: pino.Logger,
  phase: string,
  iteration: number,
): pino.Logger {
  return parent.child({ phase, iteration })
}
