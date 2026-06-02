import type { ReviewerOutput } from '../workers/types.js'

export function listReviewResults(
  reviewResults: Readonly<Record<string, ReviewerOutput>> | null | undefined,
): Array<{ key: string; result: ReviewerOutput }> {
  return Object.entries(reviewResults ?? {}).map(([key, result]) => ({ key, result }))
}

export function formatReviewSummary(
  reviewResults: Readonly<Record<string, ReviewerOutput>> | null | undefined,
): string | null {
  const entries = listReviewResults(reviewResults)
  if (entries.length === 0) return null
  if (entries.length === 1) {
    const { result } = entries[0]!
    return `${result.verdict}: ${result.summary}`
  }
  return entries
    .map(({ key, result }) => `${key}: ${result.verdict}: ${result.summary}`)
    .join('; ')
}
