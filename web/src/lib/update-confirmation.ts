export const SELF_UPDATE_CONFIRM_MESSAGE =
  'Start self-update now? This pulls latest code, rebuilds, and restarts Night-Orch services.'

export function confirmSelfUpdate(confirmFn: (message: string) => boolean): boolean {
  return confirmFn(SELF_UPDATE_CONFIRM_MESSAGE)
}
