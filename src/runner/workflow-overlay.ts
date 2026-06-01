import type { Config } from '../config/schema.js'
import type { ResolvedRoles } from '../discovery/roles.js'
import type { ResolvedWorkflow } from '../loop/workflow.js'

export function coerceAgentName(
  value: string,
  fallback: ResolvedRoles['planner'],
): ResolvedRoles['planner'] {
  if (value === 'claude' || value === 'codex' || value === 'opencode') {
    return value
  }
  return fallback
}

export function applyWorkflowAgentOverrides(
  repoConfig: Config['repos'][number],
  workflow: ResolvedWorkflow,
): Config['repos'][number] {
  if (!workflow.agents || Object.keys(workflow.agents).length === 0) {
    return repoConfig
  }
  return {
    ...repoConfig,
    agents: {
      ...repoConfig.agents,
      ...workflow.agents,
    },
  }
}

export function applyWorkflowRoleDefaults(
  repoDefaults: Config['repos'][number]['defaults'],
  workflow: ResolvedWorkflow,
  repoConfig: Config['repos'][number],
  config: Config,
): Config['repos'][number]['defaults'] {
  if (!workflow.roles) {
    return repoDefaults
  }

  const merged: Config['repos'][number]['defaults'] = {
    ...repoDefaults,
    ...workflow.roles,
  }

  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    const preferredAgent = merged[role]
    if (canResolveAgent(preferredAgent, repoConfig, config)) continue
    merged[role] = repoDefaults[role]
  }

  return merged
}

export function resolveWorkerProfileForAgent(
  agent: Config['repos'][number]['defaults']['planner'],
  repoConfig: Config['repos'][number],
  config: Config,
): Config['workerProfiles'][string] | null {
  const mappedProfileName = repoConfig.agents[agent]
  if (mappedProfileName) {
    const mappedProfile = config.workerProfiles[mappedProfileName]
    if (mappedProfile) return mappedProfile
  }

  return Object.values(config.workerProfiles).find((profile) => profile.type === agent) ?? null
}

function canResolveAgent(
  agent: Config['repos'][number]['defaults']['planner'],
  repoConfig: Config['repos'][number],
  config: Config,
): boolean {
  return resolveWorkerProfileForAgent(agent, repoConfig, config) !== null
}
