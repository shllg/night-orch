export const GIT_UPDATE_CONFIRM_MESSAGE =
  'Start self-update now? This pulls latest code, rebuilds, and restarts Night-Orch services.'

export const NPM_UPDATE_CONFIRM_MESSAGE =
  'Start self-update now? This installs the latest version from npm and restarts Night-Orch services.'

/** @deprecated Use the parameterized version instead */
export const SELF_UPDATE_CONFIRM_MESSAGE = GIT_UPDATE_CONFIRM_MESSAGE

export function confirmSelfUpdate(
  confirmFn: (message: string) => boolean,
  installMethod: 'git' | 'npm' | 'unknown' = 'unknown',
): boolean {
  const message = installMethod === 'npm' ? NPM_UPDATE_CONFIRM_MESSAGE : GIT_UPDATE_CONFIRM_MESSAGE
  return confirmFn(message)
}
