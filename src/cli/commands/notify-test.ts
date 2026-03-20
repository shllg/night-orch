import { loadConfig, resolveConfigPath, ConfigError } from '../../config/loader.js'
import { NotificationDispatcher } from '../../notify/dispatcher.js'

interface GlobalOpts {
  config?: string
  dryRun?: boolean
  logLevel?: string
}

export async function notifyTestCommand(globalOpts?: GlobalOpts): Promise<void> {
  let config
  try {
    const configPath = resolveConfigPath(globalOpts?.config)
    config = loadConfig(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error: ${err.message}`)
    } else {
      console.error((err as Error).message)
    }
    process.exitCode = 1
    return
  }

  // Override all events to enabled for test
  const testConfig = {
    ...config.notifications,
    events: {
      onRunStarted: true,
      onBlocked: true,
      onPrReady: true,
      onError: true,
      onRetryExhausted: true,
    },
  }

  const dispatcher = new NotificationDispatcher(testConfig)

  console.log('Sending test notification to all configured channels...')
  await dispatcher.notify({
    event: 'onPrReady',
    repo: 'test/test-repo',
    issueNumber: 0,
    title: 'Test Notification',
    message: 'This is a test notification from night-orch notify-test.',
  })

  console.log('Done.')
}
