import { describe, expect, it, vi } from 'vitest'

import {
  confirmSelfUpdate,
  GIT_UPDATE_CONFIRM_MESSAGE,
  NPM_UPDATE_CONFIRM_MESSAGE,
  SELF_UPDATE_CONFIRM_MESSAGE,
} from '../../web/src/lib/update-confirmation.js'

describe('update confirmation', () => {
  it('uses git message by default for unknown install method', () => {
    const confirm = vi.fn<(message: string) => boolean>().mockReturnValue(true)

    const accepted = confirmSelfUpdate(confirm, 'unknown')

    expect(accepted).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(GIT_UPDATE_CONFIRM_MESSAGE)
  })

  it('uses git message when installMethod is git', () => {
    const confirm = vi.fn<(message: string) => boolean>().mockReturnValue(true)

    const accepted = confirmSelfUpdate(confirm, 'git')

    expect(accepted).toBe(true)
    expect(confirm).toHaveBeenCalledWith(GIT_UPDATE_CONFIRM_MESSAGE)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('pulls latest code'))
  })

  it('uses npm message when installMethod is npm', () => {
    const confirm = vi.fn<(message: string) => boolean>().mockReturnValue(true)

    const accepted = confirmSelfUpdate(confirm, 'npm')

    expect(accepted).toBe(true)
    expect(confirm).toHaveBeenCalledWith(NPM_UPDATE_CONFIRM_MESSAGE)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('npm'))
  })

  it('defaults to git message when installMethod is not provided', () => {
    const confirm = vi.fn<(message: string) => boolean>().mockReturnValue(true)

    const accepted = confirmSelfUpdate(confirm)

    expect(accepted).toBe(true)
    expect(confirm).toHaveBeenCalledWith(GIT_UPDATE_CONFIRM_MESSAGE)
  })

  it('returns false when confirmation is declined', () => {
    const confirm = vi.fn<(message: string) => boolean>().mockReturnValue(false)

    const accepted = confirmSelfUpdate(confirm, 'git')

    expect(accepted).toBe(false)
  })

  it('exposes backward-compatible SELF_UPDATE_CONFIRM_MESSAGE constant', () => {
    // This constant should equal the git message for backward compatibility
    expect(SELF_UPDATE_CONFIRM_MESSAGE).toBe(GIT_UPDATE_CONFIRM_MESSAGE)
  })
})
