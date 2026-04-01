import type { PlannerOutput, CoderOutput, ReviewerOutput, VerifyResult } from '../workers/types.js'
import type { ResolvedRoles } from '../discovery/roles.js'
import type { TriageLevel } from '../discovery/triage.js'

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
