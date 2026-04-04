import { type UpdateStatus } from '../types/dashboard.js'

export const UPDATE_STATUS_TERMINAL_GRACE_MS = 6_000

export interface UpdateTransitionState {
  startedAtMs: number | null
  sawActiveState: boolean
}

export function createUpdateTransitionState(startedAtMs: number): UpdateTransitionState {
  return { startedAtMs, sawActiveState: false }
}

export function clearUpdateTransitionState(): UpdateTransitionState {
  return { startedAtMs: null, sawActiveState: false }
}

export function isUpdateInProgress(status: UpdateStatus | null): boolean {
  return status != null && status.state !== 'idle' && status.state !== 'failed'
}

export function resolveImmediateUpdateStatusAfterAccept(status: UpdateStatus): UpdateStatus | null {
  if (isUpdateInProgress(status)) {
    return status
  }
  return null
}

function shouldAcceptTerminalStatus(
  transition: UpdateTransitionState,
  nowMs: number,
  graceMs: number,
): boolean {
  if (transition.startedAtMs == null) {
    return true
  }
  if (transition.sawActiveState) {
    return true
  }
  return nowMs - transition.startedAtMs >= graceMs
}

interface UpdatePollDecision {
  nextTransition: UpdateTransitionState
  nextStatus: UpdateStatus | null
  errorMessage: string | null
  shouldReload: boolean
}

function decidePolledUpdateStatus(
  status: UpdateStatus,
  transition: UpdateTransitionState,
  nowMs: number,
  graceMs: number,
): UpdatePollDecision {
  if (isUpdateInProgress(status)) {
    return {
      nextTransition: { startedAtMs: transition.startedAtMs, sawActiveState: true },
      nextStatus: status,
      errorMessage: null,
      shouldReload: false,
    }
  }

  if (!shouldAcceptTerminalStatus(transition, nowMs, graceMs)) {
    return {
      nextTransition: transition,
      nextStatus: null,
      errorMessage: null,
      shouldReload: false,
    }
  }

  if (status.state === 'failed') {
    return {
      nextTransition: clearUpdateTransitionState(),
      nextStatus: status,
      errorMessage: `Update failed: ${status.error ?? 'unknown error'}`,
      shouldReload: false,
    }
  }

  return {
    nextTransition: clearUpdateTransitionState(),
    nextStatus: status,
    errorMessage: null,
    shouldReload: status.state === 'idle',
  }
}

export interface PollAndApplyUpdateStatusOptions {
  fetchUpdateStatus: () => Promise<UpdateStatus | null>
  transition: UpdateTransitionState
  onStatus: (status: UpdateStatus) => void
  onError: (message: string) => void
  onReload: () => void
  nowMs?: () => number
  graceMs?: number
}

export async function pollAndApplyUpdateStatus(
  options: PollAndApplyUpdateStatusOptions,
): Promise<UpdateTransitionState> {
  const status = await options.fetchUpdateStatus()
  if (!status) {
    return options.transition
  }

  const decision = decidePolledUpdateStatus(
    status,
    options.transition,
    options.nowMs ? options.nowMs() : Date.now(),
    options.graceMs ?? UPDATE_STATUS_TERMINAL_GRACE_MS,
  )

  if (decision.nextStatus) {
    options.onStatus(decision.nextStatus)
  }
  if (decision.errorMessage) {
    options.onError(decision.errorMessage)
  }
  if (decision.shouldReload) {
    options.onReload()
  }

  return decision.nextTransition
}
