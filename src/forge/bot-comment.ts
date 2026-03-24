import type { ForgeAdapter, ForgeComment } from './types.js'

const MARKER_PREFIX = '<!-- night-orch:'
const MARKER_SUFFIX = ' -->'

/** Build an HTML comment marker for a given kind (e.g., 'plan', 'status'). */
export function markerTag(kind: string): string {
  return `${MARKER_PREFIX}${kind}${MARKER_SUFFIX}`
}

/**
 * Find the bot's own comment containing the given marker.
 * Checks both marker presence and author to prevent marker spoofing.
 */
export function findBotComment(
  comments: ForgeComment[],
  marker: string,
  botUser: string,
): ForgeComment | undefined {
  return comments.find((c) => c.user === botUser && c.body.includes(marker))
}

/**
 * Create or update a bot comment on an issue using an HTML marker for dedup.
 * If a comment with the marker (authored by botUser) already exists, updates it.
 * Otherwise creates a new comment with the marker prepended.
 */
export async function upsertBotComment(
  forge: ForgeAdapter,
  repo: string,
  issueNumber: number,
  marker: string,
  body: string,
  botUser: string,
): Promise<{ created: boolean }> {
  const comments = await forge.listIssueComments(repo, issueNumber)
  const existing = findBotComment(comments, marker, botUser)

  const fullBody = `${marker}\n${body}`

  if (existing) {
    await forge.updateComment(repo, existing.id, fullBody)
    return { created: false }
  }

  await forge.commentOnIssue(repo, issueNumber, fullBody)
  return { created: true }
}
