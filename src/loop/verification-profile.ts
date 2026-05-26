import type { Config, RepoConfig } from '../config/schema.js'
import type { VerifyStep } from './workflow.js'

type VerifyCommandSpec = RepoConfig['verify'][number]

export interface ResolvedVerifyCommand {
  command: VerifyCommandSpec
  required: boolean
  stageId: string | null
  onFailure: 'block' | 'iterate' | 'warn'
}

/**
 * Resolve verify commands for a step using either:
 * 1) workflow step profile override,
 * 2) repo default verificationProfile, or
 * 3) legacy repo verify[] commands.
 */
export function resolveVerifyCommands(
  config: Config,
  repoConfig: RepoConfig,
  step: VerifyStep,
): ResolvedVerifyCommand[] {
  const selectedProfile = step.profile ?? repoConfig.verificationProfile
  if (!selectedProfile) {
    return repoConfig.verify.map((command) => ({
      command,
      required: true,
      stageId: null,
      onFailure: 'block',
    }))
  }

  const profile = config.verificationProfiles[selectedProfile]
  if (!profile) {
    throw new Error(`Verification profile "${selectedProfile}" is not defined`)
  }

  const stages = step.stage
    ? profile.stages.filter((stage) => stage.id === step.stage)
    : profile.stages

  if (step.stage && stages.length === 0) {
    throw new Error(`Verification profile "${selectedProfile}" has no stage "${step.stage}"`)
  }

  return stages.flatMap((stage) =>
    stage.commands.map((command) => ({
      command: applyStageTimeoutDefault(command, stage.timeoutSeconds),
      required: stage.required,
      stageId: stage.id,
      onFailure: stage.onFailure,
    })),
  )
}

function applyStageTimeoutDefault(
  command: VerifyCommandSpec,
  timeoutSeconds: number | undefined,
): VerifyCommandSpec {
  if (!timeoutSeconds) return command
  if (typeof command === 'string' || Array.isArray(command)) {
    return { command, timeoutSeconds }
  }
  return command
}

