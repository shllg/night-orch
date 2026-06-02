import { describe, expect, it, vi } from 'vitest'
import { resetDailyCostsAndResume } from '../../src/ops/daily-cost-reset.js'
import { initDatabase } from '../../src/state/db.js'
import { utcDayKey } from '../../src/utils/time.js'
import type { Config } from '../../src/config/schema.js'
import type { ForgeAdapter } from '../../src/forge/types.js'

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeForge(): ForgeAdapter {
  return {} as ForgeAdapter
}

describe('resetDailyCostsAndResume', () => {
  it('uses utcDayKey() for the reset date', async () => {
    const db = initDatabase(':memory:')
    const today = utcDayKey()
    const result = await resetDailyCostsAndResume(db, { repos: [] } as unknown as Config, makeForge())

    expect(result.date).toBe(today)
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
