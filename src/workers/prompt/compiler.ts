import { readFileSync, existsSync } from 'node:fs'
import type { PromptContext } from '../types.js'
import { logger } from '../../utils/logger.js'

const MAX_ISSUE_BODY_LENGTH = 4000

/**
 * Compile a prompt from template file + runtime context.
 * Templates use {{variable.path}} syntax.
 */
export function compilePrompt(
  templatePath: string | null,
  defaultTemplate: string,
  context: PromptContext,
): { systemPrompt: string; userPrompt: string } {
  // Load template
  let template = defaultTemplate
  if (templatePath && existsSync(templatePath)) {
    template = readFileSync(templatePath, 'utf-8')
  } else if (templatePath) {
    logger.warn({ templatePath }, 'Template file not found, using default')
  }

  // Build substitution map
  const vars = buildVarMap(context)
  const systemPrompt = substitute(template, vars)
  const userPrompt = buildUserPrompt(context)

  return { systemPrompt, userPrompt }
}

function buildVarMap(ctx: PromptContext): Record<string, string> {
  return {
    'role': ctx.role,
    'issue.number': String(ctx.issue.number),
    'issue.title': ctx.issue.title,
    'issue.body': sanitizeIssueBody(ctx.issue.body),
    'issue.labels': ctx.issue.labels.join(', '),
    'repo.name': ctx.repo.name,
    'repo.baseBranch': ctx.repo.baseBranch,
    'plan': ctx.plan ?? '(no plan available)',
    'iteration.current': String(ctx.iteration.current),
    'iteration.max': String(ctx.iteration.max),
    'iteration.isRetry': String(ctx.iteration.isRetry),
    'triageLevel': ctx.triageLevel,
    'reviewFindings': formatReviewFindings(ctx),
    'verifyResults': formatVerifyResults(ctx),
  }
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    return vars[key] ?? `{{${key}}}`
  })
}

function buildUserPrompt(ctx: PromptContext): string {
  const parts: string[] = []

  parts.push(`## Issue #${ctx.issue.number}: ${ctx.issue.title}`)
  parts.push('')
  parts.push(sanitizeIssueBody(ctx.issue.body))

  if (ctx.plan) {
    parts.push('')
    parts.push('## Implementation Plan')
    parts.push(ctx.plan)
  }

  if (ctx.reviewFindings && ctx.reviewFindings.length > 0) {
    parts.push('')
    parts.push('## Review Findings to Address')
    ctx.reviewFindings.forEach((f, i) => {
      parts.push(`${i + 1}. [${f.severity}] ${f.message}`)
      if (f.suggestedFix) parts.push(`   Suggested fix: ${f.suggestedFix}`)
    })
  }

  if (ctx.verifyResults && ctx.verifyResults.length > 0) {
    parts.push('')
    parts.push('## Verification Results')
    for (const r of ctx.verifyResults) {
      const icon = r.passed ? '✓' : '✗'
      parts.push(`${icon} ${r.command} (exit ${r.exitCode})`)
      if (!r.passed && r.stderr) {
        parts.push(`  stderr: ${r.stderr.slice(0, 500)}`)
      }
    }
  }

  if (ctx.iteration.isRetry) {
    parts.push('')
    parts.push(`## Iteration ${ctx.iteration.current}/${ctx.iteration.max}`)
    parts.push('This is a retry. Please address the findings above and try again.')
  }

  return parts.join('\n')
}

/**
 * Sanitize issue body to mitigate prompt injection.
 * Strips HTML tags, truncates to max length.
 */
function sanitizeIssueBody(body: string): string {
  let sanitized = body
    .replace(/<[^>]*>/g, '') // Strip HTML tags
    .replace(/<!--[\s\S]*?-->/g, '') // Strip HTML comments

  if (sanitized.length > MAX_ISSUE_BODY_LENGTH) {
    sanitized = sanitized.slice(0, MAX_ISSUE_BODY_LENGTH) + '\n\n[... truncated ...]'
  }

  return sanitized
}

function formatReviewFindings(ctx: PromptContext): string {
  if (!ctx.reviewFindings || ctx.reviewFindings.length === 0) return '(none)'
  return ctx.reviewFindings
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.message}`)
    .join('\n')
}

function formatVerifyResults(ctx: PromptContext): string {
  if (!ctx.verifyResults || ctx.verifyResults.length === 0) return '(none)'
  return ctx.verifyResults
    .map((r) => `${r.passed ? 'PASS' : 'FAIL'}: ${r.command}`)
    .join('\n')
}
