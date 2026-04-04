import { describe, expect, it, vi } from 'vitest'

import {
  createUpdateTransitionState,
  pollAndApplyUpdateStatus,
  resolveImmediateUpdateStatusAfterAccept,
  type UpdateTransitionState,
} from '../../web/src/lib/update-status-flow.js'
import { type UpdateStatus } from '../../web/src/types/dashboard.js'

describe('App update flow', () => {
  it('polls through active update states and reloads when status returns to idle', async () => {
    const fetchStatus = vi.fn<() => Promise<UpdateStatus | null>>()
      .mockResolvedValueOnce({ state: 'draining' })
      .mockResolvedValueOnce({ state: 'idle' })
    const setStatus = vi.fn<(status: UpdateStatus) => void>()
    const setError = vi.fn<(message: string) => void>()
    const reloadPage = vi.fn<() => void>()

    let transition: UpdateTransitionState = createUpdateTransitionState(1_000)

    transition = await pollAndApplyUpdateStatus({
      fetchUpdateStatus: fetchStatus,
      transition,
      onStatus: setStatus,
      onError: setError,
      onReload: reloadPage,
      nowMs: () => 1_100,
    })

    transition = await pollAndApplyUpdateStatus({
      fetchUpdateStatus: fetchStatus,
      transition,
      onStatus: setStatus,
      onError: setError,
      onReload: reloadPage,
      nowMs: () => 2_500,
    })

    expect(setStatus).toHaveBeenNthCalledWith(1, { state: 'draining' })
    expect(setStatus).toHaveBeenNthCalledWith(2, { state: 'idle' })
    expect(setError).not.toHaveBeenCalled()
    expect(reloadPage).toHaveBeenCalledTimes(1)
    expect(transition).toEqual({ startedAtMs: null, sawActiveState: false })
  })

  it('ignores stale failed status immediately after update acceptance', async () => {
    expect(resolveImmediateUpdateStatusAfterAccept({ state: 'failed', error: 'old failure' })).toBeNull()

    const fetchStatus = vi.fn<() => Promise<UpdateStatus | null>>()
      .mockResolvedValueOnce({ state: 'failed', error: 'old failure' })
      .mockResolvedValueOnce({ state: 'pulling' })
    const setStatus = vi.fn<(status: UpdateStatus) => void>()
    const setError = vi.fn<(message: string) => void>()
    const reloadPage = vi.fn<() => void>()

    let transition: UpdateTransitionState = createUpdateTransitionState(10_000)

    transition = await pollAndApplyUpdateStatus({
      fetchUpdateStatus: fetchStatus,
      transition,
      onStatus: setStatus,
      onError: setError,
      onReload: reloadPage,
      nowMs: () => 10_500,
    })

    expect(setStatus).not.toHaveBeenCalled()
    expect(setError).not.toHaveBeenCalled()
    expect(reloadPage).not.toHaveBeenCalled()
    expect(transition).toEqual({ startedAtMs: 10_000, sawActiveState: false })

    transition = await pollAndApplyUpdateStatus({
      fetchUpdateStatus: fetchStatus,
      transition,
      onStatus: setStatus,
      onError: setError,
      onReload: reloadPage,
      nowMs: () => 11_000,
    })

    expect(setStatus).toHaveBeenCalledWith({ state: 'pulling' })
    expect(setError).not.toHaveBeenCalled()
    expect(reloadPage).not.toHaveBeenCalled()
    expect(transition).toEqual({ startedAtMs: 10_000, sawActiveState: true })
  })

  it('treats failed as terminal after active polling has started', async () => {
    const fetchStatus = vi.fn<() => Promise<UpdateStatus | null>>()
      .mockResolvedValueOnce({ state: 'failed', error: 'health check failed' })
    const setStatus = vi.fn<(status: UpdateStatus) => void>()
    const setError = vi.fn<(message: string) => void>()
    const reloadPage = vi.fn<() => void>()

    const transition = await pollAndApplyUpdateStatus({
      fetchUpdateStatus: fetchStatus,
      transition: { startedAtMs: 20_000, sawActiveState: true },
      onStatus: setStatus,
      onError: setError,
      onReload: reloadPage,
      nowMs: () => 21_000,
    })

    expect(setStatus).toHaveBeenCalledWith({ state: 'failed', error: 'health check failed' })
    expect(setError).toHaveBeenCalledWith('Update failed: health check failed')
    expect(reloadPage).not.toHaveBeenCalled()
    expect(transition).toEqual({ startedAtMs: null, sawActiveState: false })
  })
})
