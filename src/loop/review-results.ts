import type { ReviewerOutput } from '../workers/types.js'

export function listReviewResults(
  reviewResults: Readonly<Record<string, ReviewerOutput>> | null | undefined,
  legacyReviewResult: ReviewerOutput | null | undefined,
): Array<{ key: string; result: ReviewerOutput }> {
  const entries = Object.entries(reviewResults ?? {})
  if (entries.length > 0) {
    return entries.map(([key, result]) => ({ key, result }))
  }
  return legacyReviewResult ? [{ key: 'review', result: legacyReviewResult }] : []
}

export function formatReviewSummary(
  reviewResults: Readonly<Record<string, ReviewerOutput>> | null | undefined,
  legacyReviewResult: ReviewerOutput | null | undefined,
): string | null {
  const entries = listReviewResults(reviewResults, legacyReviewResult)
  if (entries.length === 0) return null
  if (entries.length === 1) {
    const { result } = entries[0]!
    return `${result.verdict}: ${result.summary}`
  }
  return entries
    .map(({ key, result }) => `${key}: ${result.verdict}: ${result.summary}`)
    .join('; ')
}
