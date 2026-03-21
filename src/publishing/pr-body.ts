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
}

export function compilePRTitle(issueNumber: number, issueTitle: string): string {
  const base = `[night-orch] #${issueNumber} ${issueTitle}`
  return base.length > 256 ? base.slice(0, 253) + '...' : base
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

  // Metadata
  sections.push('---')
  sections.push('')
  sections.push(`**Triage:** ${ctx.triageLevel} | **Iterations:** ${ctx.iterationCount} | **Roles:** plan=${ctx.roles.planner} code=${ctx.roles.coder} review=${ctx.roles.reviewer}`)

  return sections.join('\n')
}
