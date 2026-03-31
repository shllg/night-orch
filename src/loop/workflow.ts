import type { Config, RepoConfig } from '../config/schema.js'
import type { TriageLevel } from '../discovery/triage.js'

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
}

export type WorkflowStep = WorkerStep | VerifyStep | DecideStep

export interface ResolvedWorkflow {
  steps: WorkflowStep[]
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

/**
 * Resolve which workflow to use for a given repo and triage level.
 * Falls back to DEFAULT_WORKFLOW when no workflow is configured.
 */
export function resolveWorkflow(
  repoConfig: RepoConfig,
  config: Config,
  _triageLevel: TriageLevel,
): ResolvedWorkflow {
  const workflowName = repoConfig.workflow
  if (!workflowName) return DEFAULT_WORKFLOW

  const workflow = config.workflows[workflowName]
  if (!workflow) return DEFAULT_WORKFLOW

  return { steps: workflow.steps as WorkflowStep[] }
}
