import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CardWeb } from '../../src/components/card/card.web.js'

describe('CardWeb', () => {
  it('renders numeric action nodes such as zero', () => {
    const html = renderToStaticMarkup(React.createElement(CardWeb, {
      title: 'Run Summary',
      actions: 0,
    }))

    expect(html).toContain('card-actions')
    expect(html).toContain('>0<')
  })

  it('does not render actions for boolean nodes', () => {
    const html = renderToStaticMarkup(React.createElement(CardWeb, {
      title: 'Run Summary',
      actions: false,
    }))

    expect(html).not.toContain('card-actions')
  })
})
