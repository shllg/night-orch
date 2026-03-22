import type { WorkerProfileInput } from './types.js'
import { parseCommandString } from '../utils/command.js'

export function buildWorkerCommand(
  profile: WorkerProfileInput,
  taskArgs: string[],
): { command: string; args: string[] } {
  if (!profile.runtimeWrapper) {
    return {
      command: profile.command,
      args: taskArgs,
    }
  }

  const wrapper = parseCommandString(profile.runtimeWrapper)
  return {
    command: wrapper.binary,
    args: [...wrapper.args, profile.command, ...taskArgs],
  }
}
