import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TextInputWeb } from '../../src/components/text-input/text-input.web.js'

describe('TextInputWeb', () => {
  it('renders default type and DaisyUI classes', () => {
    const html = renderToStaticMarkup(React.createElement(TextInputWeb, {
      defaultValue: 'night-orch/night-orch',
      size: 'sm',
    }))

    expect(html).toContain('type="text"')
    expect(html).toContain('class="input input-bordered input-sm"')
  })

  it('preserves native aria-label when ariaLabel is not provided', () => {
    const html = renderToStaticMarkup(React.createElement(TextInputWeb, {
      defaultValue: 'value',
      'aria-label': 'native label',
    }))

    expect(html).toContain('aria-label="native label"')
  })

  it('prefers ariaLabel over native aria-label when both are provided', () => {
    const html = renderToStaticMarkup(React.createElement(TextInputWeb, {
      defaultValue: 'value',
      'aria-label': 'native label',
      ariaLabel: 'custom label',
    }))

    expect(html).toContain('aria-label="custom label"')
    expect(html).not.toContain('aria-label="native label"')
  })
})
