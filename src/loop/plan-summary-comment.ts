import type { ForgeAdapter } from '../forge/types.js'
import type { PlannerOutput } from '../workers/types.js'

const MAX_STEPS = 6
const MAX_FILES = 8
const MAX_RISKS = 4
const MAX_LINE_LENGTH = 200

function compactLine(value: string): string {
  const flattened = value.replace(/\s+/g, ' ').trim()
  if (flattened.length <= MAX_LINE_LENGTH) return flattened
  return `${flattened.slice(0, MAX_LINE_LENGTH - 3).trimEnd()}...`
}

function sanitizeCodeSpan(value: string): string {
  return compactLine(value).replace(/`/g, '')
}

function hasRenderableContent(plan: PlannerOutput): boolean {
  if (plan.objective.trim().length > 0) return true
  if (plan.steps.some((step) => step.description.trim().length > 0)) return true
  if (plan.filesToChange.some((file) => file.trim().length > 0)) return true
  if (plan.risks.some((risk) => risk.trim().length > 0)) return true
  if (plan.testStrategy.trim().length > 0) return true
  return false
}

export function formatPlanSummaryComment(plan: PlannerOutput): string {
  const parts: string[] = [
    '## 🤖 [night-orch] Plan Summary',
    '',
    '> **Automated comment** posted by **night-orch** after planning and before implementation starts.',
    '',
    `**Objective:** ${compactLine(plan.objective || 'No objective provided.')}`,
  ]

  if (plan.steps.length > 0) {
    parts.push('', '**Planned steps:**')
    const sortedSteps = [...plan.steps].sort((a, b) => a.order - b.order).slice(0, MAX_STEPS)
    for (const [index, step] of sortedSteps.entries()) {
      parts.push(`${index + 1}. ${compactLine(step.description)}`)
    }
    const remaining = plan.steps.length - sortedSteps.length
    if (remaining > 0) {
      parts.push(`...and ${remaining} more planned step(s).`)
    }
  }

  if (plan.filesToChange.length > 0) {
    parts.push('', '**Expected files to change:**')
    const files = plan.filesToChange.slice(0, MAX_FILES)
    for (const file of files) {
      parts.push(`- \`${sanitizeCodeSpan(file)}\``)
    }
    const remaining = plan.filesToChange.length - files.length
    if (remaining > 0) {
      parts.push(`- ...and ${remaining} more file(s).`)
    }
  }

  if (plan.risks.length > 0) {
    parts.push('', '**Top risks:**')
    const risks = plan.risks.slice(0, MAX_RISKS)
    for (const risk of risks) {
      parts.push(`- ${compactLine(risk)}`)
    }
    const remaining = plan.risks.length - risks.length
    if (remaining > 0) {
      parts.push(`- ...and ${remaining} more risk(s).`)
    }
  }

  if (plan.testStrategy.trim().length > 0) {
    parts.push('', `**Test strategy:** ${compactLine(plan.testStrategy)}`)
  }

  return parts.join('\n')
}

export async function postPlanSummaryComment(
  forge: ForgeAdapter,
  repo: string,
  issueNumber: number,
  plan: PlannerOutput | null | undefined,
): Promise<boolean> {
  if (!plan || !hasRenderableContent(plan)) {
    return false
  }
  await forge.commentOnIssue(repo, issueNumber, formatPlanSummaryComment(plan))
  return true
}
