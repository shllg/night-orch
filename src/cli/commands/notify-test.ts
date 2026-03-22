import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { NotificationDispatcher } from '../../notify/dispatcher.js'
import { createChannels } from '../../notify/factory.js'
import { logger } from '../../utils/logger.js'

interface GlobalOpts {
  config?: string
  trustWorkspace?: boolean
  dryRun?: boolean
  logLevel?: string
}

export async function notifyTestCommand(globalOpts?: GlobalOpts): Promise<void> {
  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config, {
      trustWorkspace: globalOpts?.trustWorkspace ?? false,
    })
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error({ error: err.message }, 'Config error')
    } else {
      logger.error({ error: (err as Error).message }, 'Failed to load config')
    }
    process.exitCode = 1
    return
  }

  // Override all events to enabled for test
  const testEvents = {
    onRunStarted: true,
    onBlocked: true,
    onPrReady: true,
    onError: true,
    onRetryExhausted: true,
  }

  const channels = createChannels(config.notifications)
  const dispatcher = new NotificationDispatcher(channels, testEvents)

  logger.info('Sending test notification to all configured channels...')
  const report = await dispatcher.sendTest()

  logger.info(
    { totalSent: report.totalSent, totalFailed: report.totalFailed, channels: report.sent },
    'Test notification complete',
  )

  if (report.totalFailed > 0) {
    process.exitCode = 1
  }
}
