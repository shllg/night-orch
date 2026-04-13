import type { ForgeAdapter, ForgeComment } from './types.js'

export const MARKER_PREFIX = '<!-- night-orch:'
const MARKER_SUFFIX = ' -->'

/** Build an HTML comment marker for a given kind (e.g., 'plan', 'status'). */
export function markerTag(kind: string): string {
  return `${MARKER_PREFIX}${kind}${MARKER_SUFFIX}`
}

/**
 * Detect whether a comment/review body was authored by night-orch itself by
 * looking for the HTML marker prefix. Prefer this over author-identity checks
 * so single-user deployments (where the operator's PAT is both "bot" and
 * "human") can still distinguish bot-posted content from the human's own.
 */
export function isBotAuthored(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.includes(MARKER_PREFIX)
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
