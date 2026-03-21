import type { NotificationChannel, NotificationPayload } from '../types.js'
import { logger } from '../../utils/logger.js'

export class SmtpChannel implements NotificationChannel {
  readonly type = 'smtp'

  constructor(
    private host: string,
    private port: number,
    private from: string,
    private to: string,
    private userEnv: string,
    private passEnv: string,
  ) {}

  async send(payload: NotificationPayload): Promise<boolean> {
    const user = process.env[this.userEnv]
    const pass = process.env[this.passEnv]

    if (!user || !pass) {
      logger.warn({ userEnv: this.userEnv, passEnv: this.passEnv }, 'SMTP credentials not set — skipping')
      return false
    }

    try {
      // Dynamic import — graceful degradation if nodemailer not installed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = await import('nodemailer' as string) as { createTransport: (opts: { host: string; port: number; auth: { user: string; pass: string } }) => { sendMail: (opts: { from: string; to: string; subject: string; text: string }) => Promise<void> } }
      const { createTransport } = mod

      const transport = createTransport({
        host: this.host,
        port: this.port,
        auth: { user, pass },
      })

      await transport.sendMail({
        from: this.from,
        to: this.to,
        subject: `[night-orch] ${payload.event}: ${payload.issueTitle} (#${payload.issueNumber})`,
        text: [
          `Event: ${payload.event}`,
          `Repo: ${payload.repo}`,
          `Issue: #${payload.issueNumber} ${payload.issueTitle}`,
          `Summary: ${payload.summary}`,
          payload.prUrl ? `PR: ${payload.prUrl}` : null,
          payload.blockingReason ? `Blocked: ${payload.blockingReason}` : null,
          payload.reviewSummary ? `Review: ${payload.reviewSummary}` : null,
        ].filter(Boolean).join('\n'),
      })

      return true
    } catch (err) {
      logger.warn({ err }, 'SMTP notification failed')
      return false
    }
  }

  async validate(): Promise<{ valid: boolean; error: string | null }> {
    const user = process.env[this.userEnv]
    const pass = process.env[this.passEnv]

    if (!user || !pass) {
      return { valid: false, error: `SMTP credentials not set: ${this.userEnv} / ${this.passEnv}` }
    }

    return { valid: true, error: null }
  }
}
