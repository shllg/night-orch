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
      webClassName: 'input input-bordered',
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
      webClassName: 'input input-bordered input-warning input-xs w-full font-mono',
    })
  })
})
