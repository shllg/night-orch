import { describe, expect, it } from 'vitest'
import { buildCardViewModel } from '../../src/components/card/view-model.js'

describe('buildCardViewModel', () => {
  it('uses neutral defaults for standard cards', () => {
    const model = buildCardViewModel({
      title: 'Run Summary',
      body: 'Verification passed and the run is ready to merge.',
    })

    expect(model).toEqual({
      tone: 'neutral',
      webContainerClass: 'card shadow-panel border border-base-300/60 bg-base-200/60 backdrop-blur',
      webBodyClass: 'card-body gap-3 p-4 sm:p-5',
      tuiBorderColor: 'gray',
      tuiTitleColor: 'white',
      tuiPaddingX: 2,
      tuiPaddingY: 1,
    })
  })

  it('maps warning tone and compact spacing', () => {
    const model = buildCardViewModel({
      tone: 'warning',
      compact: true,
    })

    expect(model.webContainerClass).toContain('border-warning/40')
    expect(model.webBodyClass).toBe('card-body gap-2 p-3')
    expect(model.tuiBorderColor).toBe('yellow')
    expect(model.tuiTitleColor).toBe('yellow')
    expect(model.tuiPaddingX).toBe(1)
    expect(model.tuiPaddingY).toBe(0)
  })
})
