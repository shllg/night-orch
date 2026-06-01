import type { RepoConfig } from '../config/schema.js'

export type AgentRole = 'planner' | 'coder' | 'reviewer'
export type AgentName = 'claude' | 'codex' | 'opencode'

export interface ResolvedRoles {
  planner: AgentName
  coder: AgentName
  reviewer: AgentName
}

const VALID_AGENTS: Set<string> = new Set(['claude', 'codex', 'opencode'])
const ROLE_LABEL_PREFIXES: Record<AgentRole, string> = {
  planner: 'plan:',
  coder: 'code:',
  reviewer: 'review:',
}

/**
 * Resolve agent roles from issue labels, falling back to repo defaults.
 * Label format: plan:claude, code:codex, review:claude
 * Throws on conflicting labels (e.g., both plan:claude and plan:codex).
 */
export function resolveRoles(
  issueLabels: string[],
  repoDefaults: RepoConfig['defaults'],
): ResolvedRoles {
  const result: ResolvedRoles = {
    planner: repoDefaults.planner,
    coder: repoDefaults.coder,
    reviewer: repoDefaults.reviewer,
  }

  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    const prefix = ROLE_LABEL_PREFIXES[role]
    const matches = issueLabels
      .filter((l) => l.startsWith(prefix))
      .map((l) => l.slice(prefix.length))

    if (matches.length === 0) continue

    if (matches.length > 1) {
      throw new Error(
        `Conflicting labels for ${role}: ${matches.map((m) => `${prefix}${m}`).join(', ')}`,
      )
    }

    const agentName = matches[0]!
    if (!VALID_AGENTS.has(agentName)) {
      throw new Error(`Unknown agent "${agentName}" in label "${prefix}${agentName}". Valid: ${[...VALID_AGENTS].join(', ')}`)
    }

    result[role] = agentName as AgentName
  }

  return result
}

export function coerceAgentName(
  value: string,
  fallback: AgentName,
): AgentName {
  if (VALID_AGENTS.has(value)) {
    return value as AgentName
  }
  return fallback
}
