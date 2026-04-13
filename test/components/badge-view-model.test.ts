import { describe, expect, it } from 'vitest'
import { buildBadgeViewModel } from '../../src/components/badge/view-model.js'

describe('buildBadgeViewModel', () => {
  it('builds outline info badges with size and utility classes', () => {
    const model = buildBadgeViewModel({
      children: 'running',
      tone: 'info',
      variant: 'outline',
      size: 'sm',
      capitalize: true,
      className: 'orch-working-pulse',
    })

    expect(model).toEqual({
      tone: 'info',
      variant: 'outline',
      size: 'sm',
      webClassName: 'badge badge-info badge-sm badge-outline capitalize orch-working-pulse',
    })
  })

  it('uses neutral defaults and trims custom class names', () => {
    const model = buildBadgeViewModel({
      children: 'idle',
      className: '  custom-pill  ',
    })

    expect(model).toEqual({
      tone: undefined,
      variant: 'solid',
      size: 'md',
      webClassName: 'badge custom-pill',
    })
  })
})
