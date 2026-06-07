export interface StatusCommentSections {
  phase?: string
  plan?: string
  blockReason?: string
  error?: string
  nextStep?: string
  cost?: number
  /** Metered-equivalent cost; rendered alongside `cost` when provided. */
  theoreticalCost?: number
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
    const cost = `$${sections.cost.toFixed(4)}`
    parts.push(
      sections.theoreticalCost !== undefined
        ? `**Cost:** ${cost} real / $${sections.theoreticalCost.toFixed(4)} metered`
        : `**Cost:** ${cost}`,
    )
  }

  if (sections.retryCount !== undefined && sections.maxRetries !== undefined) {
    parts.push(`**Retries:** ${sections.retryCount}/${sections.maxRetries}`)
  }

  if (sections.nextStep) {
    parts.push(`**Next:** ${sections.nextStep}`)
  }

  if (sections.plan) {
    // Blank lines inside <details> are required for GitHub to render the
    // markdown body; the `\n\n` join below provides them between these pieces.
    parts.push('<details><summary>Plan summary</summary>')
    parts.push(sections.plan)
    parts.push('</details>')
  }

  // Join with a blank line between every field. A single `\n` makes
  // GitHub-flavored markdown collapse adjacent lines into one paragraph —
  // the "solid block of text" a human reviewer can't read.
  return parts.join('\n\n')
}
