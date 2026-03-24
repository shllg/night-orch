export interface StatusCommentSections {
  phase?: string
  plan?: string
  blockReason?: string
  error?: string
  cost?: number
  iteration?: number
  maxIterations?: number
  prUrl?: string
  retryCount?: number
  maxRetries?: number
}

/**
 * Render a consolidated status comment body for an issue.
 * Includes the status marker. Plan summary is collapsed in a <details> block.
 */
export function formatStatusComment(sections: StatusCommentSections): string {
  const parts: string[] = []

  if (sections.blockReason) {
    parts.push(`**Status:** Blocked`)
    parts.push(`**Reason:** ${sections.blockReason}`)
  } else if (sections.error) {
    parts.push(`**Status:** Error`)
    parts.push(`**Error:** ${sections.error}`)
  } else if (sections.prUrl) {
    parts.push(`**Status:** PR Ready`)
    parts.push(`**PR:** ${sections.prUrl}`)
  } else if (sections.phase) {
    parts.push(`**Status:** Running (${sections.phase})`)
  }

  if (sections.iteration !== undefined && sections.maxIterations !== undefined) {
    parts.push(`**Iteration:** ${sections.iteration}/${sections.maxIterations}`)
  }

  if (sections.cost !== undefined) {
    parts.push(`**Cost:** $${sections.cost.toFixed(4)}`)
  }

  if (sections.retryCount !== undefined && sections.maxRetries !== undefined) {
    parts.push(`**Retries:** ${sections.retryCount}/${sections.maxRetries}`)
  }

  if (sections.plan) {
    parts.push('')
    parts.push('<details><summary>Plan summary</summary>')
    parts.push('')
    parts.push(sections.plan)
    parts.push('')
    parts.push('</details>')
  }

  return parts.join('\n')
}
