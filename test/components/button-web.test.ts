import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ButtonWeb } from '../../src/components/button/button.web.js'

describe('ButtonWeb', () => {
  it('renders default button type and DaisyUI classes', () => {
    const html = renderToStaticMarkup(React.createElement(ButtonWeb, {
      tone: 'primary',
      size: 'sm',
      children: 'open',
    }))

    expect(html).toContain('<button type="button" class="btn btn-primary btn-sm">open</button>')
  })

  it('renders circle ghost button with aria label', () => {
    const html = renderToStaticMarkup(React.createElement(ButtonWeb, {
      tone: 'ghost',
      shape: 'circle',
      size: 'sm',
      ariaLabel: 'Close dialog',
      children: 'x',
    }))

    expect(html).toContain('btn-circle')
    expect(html).toContain('aria-label="Close dialog"')
  })
})
