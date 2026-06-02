import type { ReviewFinding, ReviewerOutput, SourcedReviewFinding } from '../workers/types.js'

export function sourceReviewFindings(
  reviewResult: ReviewerOutput,
  sourceStepId: string,
  sourceRole: string,
): SourcedReviewFinding[] {
  return reviewResult.findings.map((finding) => ({
    ...finding,
    sourceStepId,
    sourceRole,
  }))
}

export function mergeReviewFindings(
  existing: readonly ReviewFinding[],
  incoming: readonly ReviewFinding[],
): SourcedReviewFinding[] {
  return dedupeSourcedReviewFindings([
    ...existing.map((finding) => ensureSourcedFinding(finding)),
    ...incoming.map((finding) => ensureSourcedFinding(finding)),
  ])
}

export function dedupeSourcedReviewFindings(
  findings: readonly SourcedReviewFinding[],
): SourcedReviewFinding[] {
  const seen = new Set<string>()
  const deduped: SourcedReviewFinding[] = []
  for (const finding of findings) {
    const key = [
      finding.sourceStepId,
      finding.sourceRole,
      finding.severity,
      finding.message,
      finding.suggestedFix ?? '',
    ].join('\0')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(finding)
  }
  return deduped
}

function ensureSourcedFinding(finding: ReviewFinding): SourcedReviewFinding {
  const candidate = finding as Partial<SourcedReviewFinding>
  return {
    ...finding,
    sourceStepId: candidate.sourceStepId ?? 'review',
    sourceRole: candidate.sourceRole ?? 'reviewer',
  }
}
