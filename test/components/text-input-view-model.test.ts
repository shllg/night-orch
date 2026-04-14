import { describe, expect, it } from 'vitest'
import { buildTextInputViewModel } from '../../src/components/text-input/view-model.js'

describe('buildTextInputViewModel', () => {
  it('uses neutral defaults', () => {
    const model = buildTextInputViewModel({
      defaultValue: 'night-orch/night-orch',
    })

    expect(model).toEqual({
      tone: 'neutral',
      size: 'md',
      webClassName: 'input',
    })
  })

  it('maps tone, size, full width, and custom class names', () => {
    const model = buildTextInputViewModel({
      value: '42',
      tone: 'warning',
      size: 'xs',
      fullWidth: true,
      className: 'font-mono',
    })

    expect(model).toEqual({
      tone: 'warning',
      size: 'xs',
      webClassName: 'input input-warning input-xs w-full font-mono',
    })
  })

  it('never emits DaisyUI v4 *-bordered classes', () => {
    const toneCases = ['neutral', 'info', 'warning', 'error'] as const
    const sizeCases = ['xs', 'sm', 'md'] as const
    for (const tone of toneCases) {
      for (const size of sizeCases) {
        const model = buildTextInputViewModel({ tone, size })
        expect(model.webClassName).not.toMatch(/\binput-bordered\b/)
      }
    }
  })
})
