import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { NotificationChannel } from './types.js'
import { ConsoleChannel } from './channels/console.js'
import { WebhookChannel } from './channels/webhook.js'
import { GitHubCommentChannel } from './channels/github-comment.js'
import { logger } from '../utils/logger.js'

export function createChannels(
  config: Config['notifications'],
  forge?: ForgeAdapter,
): NotificationChannel[] {
  const channels: NotificationChannel[] = []

  for (const ch of config.channels) {
    switch (ch.type) {
      case 'console':
        channels.push(new ConsoleChannel())
        break
      case 'webhook': {
        const url = process.env[ch.urlEnv]
        if (!url) {
          logger.warn({ urlEnv: ch.urlEnv }, 'Webhook URL env var not set — skipping channel')
          break
        }
        channels.push(new WebhookChannel(url))
        break
      }
      default:
        // Exhaustive check — all known types handled above
        break
    }
  }

  // Add GitHub comment channel if forge is available
  if (forge) {
    channels.push(new GitHubCommentChannel(forge))
  }

  return channels
}
