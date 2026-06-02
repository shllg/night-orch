import type { CoderOutput, PlannerOutput, ReviewerOutput, VerifyResult } from '../workers/types.js'
import { sanitizeUntrustedText } from '../workers/prompt/compiler.js'

export interface RenderedHandoff {
  readonly summary: string
  readonly contentMd: string
  readonly contentJson: unknown
}

export function renderPlanHandoff(plan: PlannerOutput): RenderedHandoff {
  const objective = sanitizeUntrustedText(plan.objective)
  const files = plan.filesToChange.map(sanitizeUntrustedText)
  const steps = plan.steps.map((step) => ({
    ...step,
    description: sanitizeUntrustedText(step.description),
    files: step.files.map(sanitizeUntrustedText),
  }))
  const assumptions = plan.assumptions.map(sanitizeUntrustedText)
  const risks = plan.risks.map(sanitizeUntrustedText)
  const testStrategy = sanitizeUntrustedText(plan.testStrategy)

  const lines = [
    '## Plan',
    '',
    `Objective: ${objective}`,
  ]

  appendListSection(lines, 'Assumptions:', assumptions)
  appendListSection(lines, 'Files to change:', files)

  lines.push('', 'Steps:')
  for (const step of steps) {
    lines.push(`${step.order}. ${step.description}`)
    if (step.files.length > 0) {
      lines.push(`   Files: ${step.files.join(', ')}`)
    }
  }

  appendListSection(lines, 'Risks:', risks)

  lines.push('', 'Test strategy:', testStrategy)

  return {
    summary: `Plan: ${objective} (${plan.steps.length} ${pluralize(plan.steps.length, 'step')}, ${files.length} ${pluralize(files.length, 'file')})`,
    contentMd: lines.join('\n'),
    contentJson: plan,
  }
}

export function renderCodeHandoff(code: CoderOutput): RenderedHandoff {
  const summary = sanitizeUntrustedText(code.summary)
  const changedFiles = code.changedFiles.map(sanitizeUntrustedText)
  const remainingUncertainty = code.remainingUncertainty
    ? sanitizeUntrustedText(code.remainingUncertainty)
    : null
  const blockers = code.blockers?.map(sanitizeUntrustedText) ?? []

  const lines = [
    '## Code Summary',
    '',
    summary,
  ]

  appendListSection(lines, 'Changed files:', changedFiles)

  if (remainingUncertainty) {
    lines.push('', 'Remaining uncertainty:', remainingUncertainty)
  }

  appendListSection(lines, 'Blockers:', blockers)

  return {
    summary: `Code: ${summary} (${changedFiles.length} ${pluralize(changedFiles.length, 'file')})`,
    contentMd: lines.join('\n'),
    contentJson: code,
  }
}

export function renderReviewHandoff(review: ReviewerOutput, stepId: string): RenderedHandoff {
  const summary = sanitizeUntrustedText(review.summary)
  const findings = review.findings.map((finding) => ({
    ...finding,
    message: sanitizeUntrustedText(finding.message),
    suggestedFix: finding.suggestedFix ? sanitizeUntrustedText(finding.suggestedFix) : null,
  }))
  const stepLabel = sanitizeUntrustedText(stepId)

  const lines = [
    `## Review Findings: ${stepLabel}`,
    '',
    `Verdict: ${review.verdict}`,
    '',
    summary,
  ]

  if (findings.length > 0) {
    lines.push('', 'Findings:')
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.message}`)
      if (finding.suggestedFix) {
        lines.push(`  Suggested fix: ${finding.suggestedFix}`)
      }
    }
  }

  lines.push(
    '',
    'Definition of done:',
    `- Issue addressed: ${yesNo(review.definitionOfDoneCheck.issueAddressed)}`,
    `- Tests passing: ${yesNo(review.definitionOfDoneCheck.testsPassing)}`,
    `- No blocking findings: ${yesNo(review.definitionOfDoneCheck.noBlockingFindings)}`,
  )

  return {
    summary: `Review: ${review.verdict} (${findings.length} ${pluralize(findings.length, 'finding')})`,
    contentMd: lines.join('\n'),
    contentJson: review,
  }
}

export function renderExternalReviewHandoff(review: ReviewerOutput, stepId: string): RenderedHandoff {
  const summary = sanitizeUntrustedText(review.summary)
  const findings = review.findings.map((finding) => ({
    ...finding,
    message: sanitizeUntrustedText(finding.message),
    suggestedFix: finding.suggestedFix ? sanitizeUntrustedText(finding.suggestedFix) : null,
  }))
  const stepLabel = sanitizeUntrustedText(stepId)

  const lines = [
    `## External Review: ${stepLabel}`,
    '',
    `Verdict: ${review.verdict}`,
    '',
    summary,
  ]

  if (findings.length > 0) {
    lines.push('', 'Findings:')
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.message}`)
      if (finding.suggestedFix) {
        lines.push(`  Suggested fix: ${finding.suggestedFix}`)
      }
    }
  }

  return {
    summary: verdictFindingSummary(review.verdict, findings.length),
    contentMd: lines.join('\n'),
    contentJson: review,
  }
}

export function renderVerifyHandoff(results: VerifyResult[]): RenderedHandoff {
  const passed = results.filter((result) => result.passed).length
  const lines = [
    '## Verify Summary',
    '',
    `Passed: ${passed}/${results.length}`,
  ]

  results.forEach((result, index) => {
    lines.push(
      '',
      `${index + 1}. ${sanitizeUntrustedText(result.command)}`,
    )
    if (result.stageId) {
      lines.push(`   Stage: ${sanitizeUntrustedText(result.stageId)}`)
    }
    lines.push(
      `   Status: ${result.passed ? 'passed' : 'failed'}`,
      `   Required: ${yesNo(result.required ?? true)}`,
      `   Exit code: ${result.exitCode}`,
      `   Duration: ${result.durationMs}ms`,
    )
    appendOutputLine(lines, 'stdout', result.stdout)
    appendOutputLine(lines, 'stderr', result.stderr)
  })

  return {
    summary: `Verify: ${passed}/${results.length} passed`,
    contentMd: lines.join('\n'),
    contentJson: results,
  }
}

function appendListSection(lines: string[], heading: string, items: string[]): void {
  if (items.length === 0) return
  lines.push('', heading)
  for (const item of items) {
    lines.push(`- ${item}`)
  }
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

function verdictFindingSummary(verdict: ReviewerOutput['verdict'], count: number): string {
  return `${verdict}: ${count} ${pluralize(count, 'finding')}`
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no'
}

function appendOutputLine(lines: string[], label: 'stdout' | 'stderr', value: string): void {
  const sanitized = sanitizeUntrustedText(value)
  if (sanitized.length === 0) return
  lines.push(`   ${label}: ${sanitized}`)
}
