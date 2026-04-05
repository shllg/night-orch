import { describe, expect, it } from 'vitest'
import { buildButtonViewModel } from '../../src/components/button/view-model.js'

describe('buildButtonViewModel', () => {
  it('maps info outline button classes used by dashboard actions', () => {
    const model = buildButtonViewModel({
      children: 'apply',
      tone: 'info',
      size: 'sm',
      variant: 'outline',
      fullWidth: true,
      className: 'justify-between',
    })

    expect(model).toEqual({
      tone: 'info',
      variant: 'outline',
      size: 'sm',
      shape: 'default',
      webClassName: 'btn btn-info btn-sm btn-outline w-full justify-between',
      tuiColor: 'cyan',
    })
  })

  it('does not add outline class to ghost buttons', () => {
    const model = buildButtonViewModel({
      children: 'clear',
      tone: 'ghost',
      size: 'xs',
      variant: 'outline',
      shape: 'circle',
    })

    expect(model.webClassName).toBe('btn btn-ghost btn-xs btn-circle')
  })
})
