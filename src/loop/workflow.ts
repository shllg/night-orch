import type { Config, RepoConfig } from '../config/schema.js'
import type { TriageLevel } from '../discovery/triage.js'
import { isPlanningIssue } from '../planning/mode.js'

export type WorkflowRoleName = 'planner' | 'coder' | 'reviewer'
export type WorkflowAgentName = 'claude' | 'codex' | 'opencode'

export type WorkerStep = {
  type: 'worker'
  id: string
  role: string
  skipWhen?: string
  continueFrom?: string
  prompt?: string
}

export type VerifyStep = {
  type: 'verify'
  id: string
  skipWhen?: string
}

export type DecideStep = {
  type: 'decide'
  id: string
  onIterate: string
  requireReview?: boolean
}

export type WorkflowStep = WorkerStep | VerifyStep | DecideStep

export interface ResolvedWorkflow {
  steps: WorkflowStep[]
  roles?: Partial<Record<WorkflowRoleName, WorkflowAgentName>>
  agents?: Record<string, string>
}

export const DEFAULT_WORKFLOW: ResolvedWorkflow = {
  steps: [
    { type: 'worker', id: 'plan', role: 'planner', skipWhen: 'trivial' },
    { type: 'worker', id: 'code', role: 'coder', continueFrom: 'plan' },
    { type: 'verify', id: 'verify' },
    { type: 'worker', id: 'review', role: 'reviewer' },
    { type: 'decide', id: 'decide', onIterate: 'code' },
  ],
}

export const LIGHTWEIGHT_WORKFLOW: ResolvedWorkflow = {
  steps: [
    { type: 'worker', id: 'code', role: 'coder' },
    { type: 'verify', id: 'verify' },
    { type: 'decide', id: 'decide', onIterate: 'code', requireReview: false },
  ],
  roles: {
    coder: 'codex',
    reviewer: 'codex',
  },
}

export const PLANNING_ONLY_WORKFLOW: ResolvedWorkflow = {
  steps: [
    { type: 'worker', id: 'plan', role: 'planner' },
    { type: 'worker', id: 'code', role: 'coder', continueFrom: 'plan' },
    { type: 'decide', id: 'decide', onIterate: 'code' },
  ],
}

/**
 * Resolve which workflow to use for a given repo and triage level.
 * Falls back to DEFAULT_WORKFLOW when no workflow is configured.
 */
export function resolveWorkflow(
  repoConfig: RepoConfig,
  config: Config,
  issueLabels: string[],
  triageLevel: TriageLevel,
): ResolvedWorkflow {
  if (isPlanningIssue(issueLabels, repoConfig)) return PLANNING_ONLY_WORKFLOW

  const triageWorkflow = triageLevel === 'trivial' || triageLevel === 'standard'
    ? repoConfig.workflowByTriage?.[triageLevel]
    : undefined
  if (triageWorkflow) {
    const resolved = resolveConfiguredWorkflow(config, triageWorkflow)
    if (resolved) return resolved
  }

  const workflowName = repoConfig.workflow
  if (workflowName) {
    const resolved = resolveConfiguredWorkflow(config, workflowName)
    if (resolved) return resolved
  }

  if (triageLevel === 'trivial') return LIGHTWEIGHT_WORKFLOW
  return DEFAULT_WORKFLOW
}

function resolveConfiguredWorkflow(config: Config, workflowName: string): ResolvedWorkflow | null {
  const workflow = config.workflows[workflowName]
  if (!workflow) return null

  return {
    steps: workflow.steps as WorkflowStep[],
    ...(workflow.roles ? { roles: workflow.roles } : {}),
    ...(workflow.agents ? { agents: workflow.agents } : {}),
  }
}
