import type { PlannerOutput, CoderOutput, ReviewerOutput, VerifyResult } from '../workers/types.js'
import type { ResolvedRoles } from '../discovery/roles.js'
import type { TriageLevel } from '../discovery/triage.js'
import type { AiClient } from '../ai/types.js'
import { isAiError } from '../ai/errors.js'
import { logger } from '../utils/logger.js'

export interface PRBodyContext {
  issue: { number: number; title: string; url: string }
  plan: PlannerOutput | null
  codeResult: CoderOutput | null
  verifyResults: VerifyResult[]
  reviewResult: ReviewerOutput | null
  roles: ResolvedRoles
  iterationCount: number
  triageLevel: TriageLevel
  subtaskSummaries?: { title: string; summary: string; success: boolean }[]
}

const MAX_PR_BODY_CHARS = 60_000
const MAX_PR_TITLE_CHARS = 256

const PREFIX_RULES: Array<{ prefix: string; keywords: string[] }> = [
  { prefix: 'FIX', keywords: ['bug', 'fix', 'bugfix', 'hotfix', 'regression'] },
  { prefix: 'FEAT', keywords: ['feat', 'feature', 'enhancement'] },
  { prefix: 'DOCS', keywords: ['doc', 'docs', 'documentation'] },
  { prefix: 'REFACTOR', keywords: ['refactor', 'cleanup'] },
  { prefix: 'PERF', keywords: ['perf', 'performance', 'optimization'] },
  { prefix: 'TEST', keywords: ['test', 'tests', 'testing'] },
  { prefix: 'BUILD', keywords: ['build', 'deps', 'dependencies', 'dependency'] },
  { prefix: 'CI', keywords: ['ci', 'pipeline'] },
  { prefix: 'STYLE', keywords: ['style', 'format', 'formatting'] },
  { prefix: 'CHORE', keywords: ['chore', 'maintenance'] },
]

export function compilePRTitle(issueNumber: number, issueTitle: string, issueLabels: string[] = []): string {
  const prefix = deriveConventionalPrefix(issueLabels)
  const suffix = ` (night-orch / #${issueNumber})`
  const rawTitle = sanitizeTitle(issueTitle)
  const fixedLength = `[${prefix}] `.length + suffix.length

  if (fixedLength >= MAX_PR_TITLE_CHARS) {
    return `[${prefix}]${suffix}`.slice(0, MAX_PR_TITLE_CHARS)
  }

  const maxTitleLength = MAX_PR_TITLE_CHARS - fixedLength
  const title = rawTitle.length > maxTitleLength
    ? rawTitle.slice(0, Math.max(0, maxTitleLength - 3)).trimEnd() + '...'
    : rawTitle

  return `[${prefix}] ${title}${suffix}`
}

export function compilePRBody(ctx: PRBodyContext): string {
  const sections: string[] = []

  // Header
  sections.push(`Closes #${ctx.issue.number}`)
  sections.push('')

  // Plan summary
  if (ctx.plan) {
    sections.push('## Plan')
    sections.push(`**Objective:** ${ctx.plan.objective}`)
    if (ctx.plan.steps.length > 0) {
      sections.push('')
      for (const step of ctx.plan.steps) {
        sections.push(`${step.order}. ${step.description}`)
      }
    }
    sections.push('')
  }

  // Implementation summary
  if (ctx.codeResult) {
    sections.push('## Implementation')
    sections.push(ctx.codeResult.summary)
    if (ctx.codeResult.changedFiles.length > 0) {
      sections.push('')
      sections.push('**Changed files:**')
      for (const f of ctx.codeResult.changedFiles) {
        sections.push(`- \`${f}\``)
      }
    }
    sections.push('')
  }

  // Verify results
  if (ctx.verifyResults.length > 0) {
    sections.push('## Verification')
    sections.push('')
    sections.push('| Command | Result |')
    sections.push('| --- | --- |')
    for (const r of ctx.verifyResults) {
      const icon = r.passed ? ':white_check_mark:' : ':x:'
      sections.push(`| \`${r.command}\` | ${icon} |`)
    }
    sections.push('')
  }

  // Review summary
  if (ctx.reviewResult) {
    sections.push('## Review')
    sections.push(`**Verdict:** ${ctx.reviewResult.verdict}`)
    sections.push(ctx.reviewResult.summary)
    sections.push('')
  }

  // Sub-task summaries
  if (ctx.subtaskSummaries && ctx.subtaskSummaries.length > 0) {
    sections.push('## Sub-Tasks')
    sections.push('')
    for (const st of ctx.subtaskSummaries) {
      const icon = st.success ? ':white_check_mark:' : ':x:'
      sections.push(`### ${icon} ${st.title}`)
      sections.push(st.summary)
      sections.push('')
    }
  }

  // Metadata
  sections.push('---')
  sections.push('')
  sections.push(`**Triage:** ${ctx.triageLevel} | **Iterations:** ${ctx.iterationCount} | **Roles:** plan=${ctx.roles.planner} code=${ctx.roles.coder} review=${ctx.roles.reviewer}`)

  const body = sections.join('\n')
  if (body.length <= MAX_PR_BODY_CHARS) return body
  return `${body.slice(0, MAX_PR_BODY_CHARS)}\n\n[... truncated by night-orch due to size ...]`
}

/**
 * Phase 3b: generate a plain-English tl;dr summary for the top of
 * a PR body using an `AiClient`.
 *
 * Returns either the summary text or `null` on any failure (no AI
 * available, API error, schema violation). Callers prepend the
 * returned text to the structured body when present and fall
 * through unchanged when absent — so the template-only body
 * remains the baseline, and the summary is pure enrichment.
 *
 * The summary exists because the structured body is precise but
 * hard to skim on a mobile PR notification. A 2-3 sentence human
 * summary at the top gives reviewers enough context to decide
 * whether to open the PR without parsing the plan/code/review
 * sections.
 */
export async function generatePrBodySummary(
  ctx: PRBodyContext,
  ai: AiClient,
): Promise<string | null> {
  if (!ctx.plan && !ctx.codeResult) {
    // Nothing interesting to summarize — the template handles
    // empty runs (draft PRs, dry runs) without an LLM.
    return null
  }

  try {
    const prompt = buildSummaryPrompt(ctx)
    const response = await ai.complete({
      system: [
        'You write concise pull-request summaries for software engineers.',
        'Given the structured plan / code / review artifacts from an autonomous run, write 2-3 sentences in plain English explaining what the PR changes and why.',
        'Focus on observable behavior, not implementation details. No markdown, no bullet lists, no greeting, no sign-off.',
      ].join('\n'),
      user: prompt,
      maxTokens: 300,
      temperature: 0.2,
      timeoutMs: 15_000,
    })

    const summary = response.text.trim()
    if (summary.length === 0) return null
    // Hard cap to keep the PR body bounded.
    return summary.length > 600 ? `${summary.slice(0, 600).trimEnd()}…` : summary
  } catch (err) {
    if (isAiError(err)) {
      logger.debug(
        { code: err.code, err: err.message },
        'PR body summary generation failed — using template-only body',
      )
    } else {
      logger.warn({ err }, 'Unexpected error during PR body summary generation')
    }
    return null
  }
}

function buildSummaryPrompt(ctx: PRBodyContext): string {
  const parts: string[] = []
  parts.push(`Issue: #${ctx.issue.number} — ${ctx.issue.title}`)
  if (ctx.plan) {
    parts.push('')
    parts.push(`Plan objective: ${ctx.plan.objective}`)
    if (ctx.plan.steps.length > 0) {
      parts.push('Plan steps:')
      for (const step of ctx.plan.steps.slice(0, 6)) {
        parts.push(`  ${step.order}. ${step.description}`)
      }
    }
  }
  if (ctx.codeResult) {
    parts.push('')
    parts.push(`Code summary: ${ctx.codeResult.summary}`)
    if (ctx.codeResult.changedFiles.length > 0) {
      const files = ctx.codeResult.changedFiles.slice(0, 10).join(', ')
      parts.push(`Changed files: ${files}${ctx.codeResult.changedFiles.length > 10 ? ', …' : ''}`)
    }
  }
  if (ctx.reviewResult) {
    parts.push('')
    parts.push(`Review verdict: ${ctx.reviewResult.verdict}`)
    parts.push(`Review summary: ${ctx.reviewResult.summary}`)
  }
  parts.push('')
  parts.push('Write a 2-3 sentence plain-English summary a reviewer can scan on a phone notification.')
  return parts.join('\n')
}

/**
 * Combines `compilePRBody` with `generatePrBodySummary`. When the
 * AI client is null or the summary generation fails, returns the
 * existing template body unchanged. When it succeeds, prepends a
 * `## Summary` section at the top.
 */
export async function compilePRBodyWithAi(
  ctx: PRBodyContext,
  ai: AiClient | null,
): Promise<string> {
  const base = compilePRBody(ctx)
  if (!ai) return base

  const summary = await generatePrBodySummary(ctx, ai)
  if (!summary) return base

  return `## Summary\n\n${summary}\n\n${base}`
}

function sanitizeTitle(title: string): string {
  return title
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function deriveConventionalPrefix(issueLabels: string[]): string {
  const tokens = new Set(
    issueLabels.flatMap((label) => tokenizeLabel(label)),
  )

  for (const rule of PREFIX_RULES) {
    if (rule.keywords.some((keyword) => tokens.has(keyword))) {
      return rule.prefix
    }
  }

  return 'CHORE'
}

function tokenizeLabel(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
}
