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
  reviewerKey?: string
}

export type VerifyStep = {
  type: 'verify'
  id: string
  skipWhen?: string
  profile?: string
  stage?: string
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

type WorkflowDagWorkerStage = {
  type: 'worker'
  role: string
  skipWhen?: string
  continueFrom?: string
  prompt?: string
  reviewerKey?: string
  next?: string
}

type WorkflowDagVerifyStage = {
  type: 'verify'
  skipWhen?: string
  profile?: string
  stage?: string
  next?: string
}

type WorkflowDagDecideStage = {
  type: 'decide'
  onIterate: string
  requireReview?: boolean
}

type WorkflowDagStage = WorkflowDagWorkerStage | WorkflowDagVerifyStage | WorkflowDagDecideStage

type WorkflowDagDefinition = {
  entry: string
  stages: Record<string, WorkflowDagStage>
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

  const steps = workflow.steps
    ? workflow.steps as WorkflowStep[]
    : workflow.dag
      ? expandWorkflowDag(workflowName, workflow.dag as WorkflowDagDefinition)
      : null
  if (!steps) return null

  return {
    steps,
    ...(workflow.roles ? { roles: workflow.roles } : {}),
    ...(workflow.agents ? { agents: workflow.agents } : {}),
  }
}

function expandWorkflowDag(workflowName: string, dag: WorkflowDagDefinition): WorkflowStep[] {
  const stages = dag.stages
  const steps: WorkflowStep[] = []
  const visited = new Set<string>()
  const activePath = new Set<string>()

  let currentId: string | null = dag.entry

  while (currentId) {
    if (activePath.has(currentId)) {
      throw new Error(`Workflow "${workflowName}" DAG contains a cycle at stage "${currentId}"`)
    }
    if (visited.has(currentId)) {
      throw new Error(`Workflow "${workflowName}" DAG revisits stage "${currentId}" on the active path`)
    }

    const stage: WorkflowDagStage | undefined = stages[currentId]
    if (!stage) {
      throw new Error(`Workflow "${workflowName}" DAG references unknown stage "${currentId}"`)
    }

    activePath.add(currentId)
    visited.add(currentId)

    switch (stage.type) {
      case 'worker':
        steps.push({
          type: 'worker',
          id: currentId,
          role: stage.role,
          ...(stage.skipWhen ? { skipWhen: stage.skipWhen } : {}),
          ...(stage.continueFrom ? { continueFrom: stage.continueFrom } : {}),
          ...(stage.prompt ? { prompt: stage.prompt } : {}),
          ...(stage.reviewerKey ? { reviewerKey: stage.reviewerKey } : {}),
        })
        if (!stage.next) {
          throw new Error(
            `Workflow "${workflowName}" DAG stage "${currentId}" must set "next" because worker stages are non-terminal`,
          )
        }
        currentId = stage.next
        break
      case 'verify':
        steps.push({
          type: 'verify',
          id: currentId,
          ...(stage.skipWhen ? { skipWhen: stage.skipWhen } : {}),
          ...(stage.profile ? { profile: stage.profile } : {}),
          ...(stage.stage ? { stage: stage.stage } : {}),
        })
        if (!stage.next) {
          throw new Error(
            `Workflow "${workflowName}" DAG stage "${currentId}" must set "next" because verify stages are non-terminal`,
          )
        }
        currentId = stage.next
        break
      case 'decide':
        steps.push({
          type: 'decide',
          id: currentId,
          onIterate: stage.onIterate,
          ...(stage.requireReview !== undefined ? { requireReview: stage.requireReview } : {}),
        })
        currentId = null
        break
    }
  }

  if (steps.length === 0) {
    throw new Error(`Workflow "${workflowName}" DAG did not resolve to any executable steps`)
  }

  const terminal = steps[steps.length - 1]
  if (!terminal || terminal.type !== 'decide') {
    throw new Error(`Workflow "${workflowName}" DAG must terminate at a decide stage`)
  }

  return steps
}

export function reviewerKeyForStep(step: Pick<WorkerStep, 'id' | 'reviewerKey'>): string {
  return step.reviewerKey ?? step.id
}
