import type { RunContext } from '../loop/types.js'
import type { ForgeAdapter } from '../forge/types.js'
import { blockedReasonFromLegacy, blockReasonSummary } from '../loop/state.js'
import { markerTag, upsertBotComment } from '../forge/bot-comment.js'
import { formatStatusComment } from '../forge/status-comment.js'
import { logger } from '../utils/logger.js'

export const STATUS_MARKER = markerTag('status')

const ERROR_COMMENT_MAX_LENGTH = 400
const TOKEN_REDACTION_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
]

export function buildBlockReason(ctx: RunContext): string {
  const blockMessage = ctx.stepOutputs?.['blockMessage']
  if (typeof blockMessage === 'string' && blockMessage.trim().length > 0) {
    return blockMessage
  }

  if (ctx.reviewResult) {
    const findings = ctx.reviewResult.findings
      .filter((f) => f.severity === 'critical' || f.severity === 'major')
      .map((f) => `[${f.severity}] ${f.message}`)
      .join('; ')
    return findings
      ? `${ctx.reviewResult.summary} — ${findings}`
      : ctx.reviewResult.summary
  }

  if (ctx.blockReason) {
    // Bridge: ctx.blockReason is still the legacy string enum (R1d will
    // retype). Lift through fromLegacy so blockReasonSummary only sees
    // the typed shape.
    return blockReasonSummary(blockedReasonFromLegacy(ctx.blockReason), ctx)
  }

  return `Blocked in phase ${ctx.currentPhase} (no review result available)`
}

export function formatBlockComment(reason: string, ctx: RunContext): string {
  const parts = [`⛔ **night-orch**: Run blocked.\n\n**Reason:** ${reason}`]
  if (ctx.reviewResult?.findings && ctx.reviewResult.findings.length > 0) {
    parts.push('\n**Findings:**')
    for (const f of ctx.reviewResult.findings) {
      const fix = f.suggestedFix ? ` → ${f.suggestedFix}` : ''
      parts.push(`- **${f.severity}**: ${f.message}${fix}`)
    }
  }
  parts.push(`\n*Iteration ${ctx.iteration}, cost: $${ctx.estimatedCostUsd.toFixed(4)}*`)
  return parts.join('\n')
}

export interface PostStatusCommentParams {
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  botUser: string
  body: string
  warnMessage: string
}

export async function postStatusComment(params: PostStatusCommentParams): Promise<void> {
  const { forge, issueRepo, issueNumber, botUser, body, warnMessage } = params
  try {
    if (botUser) {
      await upsertBotComment(forge, issueRepo, issueNumber, STATUS_MARKER, body, botUser)
    } else {
      await forge.commentOnIssue(issueRepo, issueNumber, body)
    }
  } catch (commentErr) {
    logger.warn({ repo: issueRepo, issueNumber, err: commentErr }, warnMessage)
  }
}

export interface PostErrorStatusCommentParams {
  forge: ForgeAdapter
  issueRepo: string
  issueNumber: number
  botUser: string
  error: string
  retryCount: number
  maxRetries: number
  nextStep: string
  warnMessage: string
}

export async function postErrorStatusComment(params: PostErrorStatusCommentParams): Promise<void> {
  const { forge, issueRepo, issueNumber, botUser, error, retryCount, maxRetries, nextStep, warnMessage } = params
  const sanitizedError = sanitizeErrorForComment(error)
  const body = formatStatusComment({
    error: sanitizedError,
    retryCount,
    maxRetries,
    nextStep,
  })
  await postStatusComment({ forge, issueRepo, issueNumber, botUser, body, warnMessage })
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim().length > 0) {
    return err.message
  }
  return String(err)
}

export function sanitizeErrorForComment(errorMessage: string): string {
  let sanitized = errorMessage.replace(/[\r\n]+/g, ' ')
  sanitized = stripControlChars(sanitized)
  sanitized = sanitized
    .replace(/\b(token|secret|password|passwd|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .trim()

  for (const pattern of TOKEN_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }

  sanitized = sanitized.replace(/\s+/g, ' ').trim()
  if (!sanitized) return 'unknown error'

  const clipped = sanitized.length > ERROR_COMMENT_MAX_LENGTH
    ? `${sanitized.slice(0, ERROR_COMMENT_MAX_LENGTH - 1)}…`
    : sanitized

  return escapeMarkdownForComment(clipped)
}

function escapeMarkdownForComment(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_#[\]])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200B')
}

function stripControlChars(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if ((code >= 0 && code <= 31) || code === 127) {
      out += ' '
      continue
    }
    out += ch
  }
  return out
}
