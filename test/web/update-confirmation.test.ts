import { describe, expect, it, vi } from 'vitest'

import { confirmSelfUpdate, SELF_UPDATE_CONFIRM_MESSAGE } from '../../web/src/lib/update-confirmation.js'

describe('update confirmation', () => {
  it('uses the expected confirmation prompt', () => {
    const confirm = vi.fn<(message: string) => boolean>().mockReturnValue(true)

    const accepted = confirmSelfUpdate(confirm)

    expect(accepted).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(SELF_UPDATE_CONFIRM_MESSAGE)
  })

  it('returns false when confirmation is declined', () => {
    const confirm = vi.fn<(message: string) => boolean>().mockReturnValue(false)

    const accepted = confirmSelfUpdate(confirm)

    expect(accepted).toBe(false)
  })
})
