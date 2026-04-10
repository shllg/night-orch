import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ForgeAdapter } from '../forge/types.js'
import type { NotificationChannel } from './types.js'
import { ConsoleChannel } from './channels/console.js'
import { WebhookChannel } from './channels/webhook.js'
import { DiscordChannel } from './channels/discord.js'
import { SmtpChannel } from './channels/smtp.js'
import { GitHubCommentChannel } from './channels/github-comment.js'
import { WebPushChannel } from './channels/webpush.js'
import { logger } from '../utils/logger.js'

export function createChannels(
  config: Config['notifications'],
  forge?: ForgeAdapter,
  db?: Database.Database,
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
      case 'discord': {
        const url = process.env[ch.urlEnv]
        if (!url) {
          logger.warn({ urlEnv: ch.urlEnv }, 'Discord webhook URL env var not set — skipping channel')
          break
        }
        channels.push(new DiscordChannel(url))
        break
      }
      case 'smtp':
        channels.push(new SmtpChannel(
          ch.host,
          ch.port,
          ch.from,
          ch.to,
          ch.userEnv,
          ch.passEnv,
        ))
        break
      case 'webpush': {
        if (!db) {
          logger.warn('webpush channel requires a database handle — skipping')
          break
        }
        const publicKey = process.env[ch.vapidPublicKeyEnv]
        const privateKey = process.env[ch.vapidPrivateKeyEnv]
        const subject = process.env[ch.vapidSubjectEnv]
        if (!publicKey || !privateKey || !subject) {
          logger.warn(
            {
              vapidPublicKeyEnv: ch.vapidPublicKeyEnv,
              vapidPrivateKeyEnv: ch.vapidPrivateKeyEnv,
              vapidSubjectEnv: ch.vapidSubjectEnv,
            },
            'Web push VAPID env vars not fully set — skipping channel',
          )
          break
        }
        channels.push(new WebPushChannel(db, publicKey, privateKey, subject))
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
