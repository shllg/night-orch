import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToString } from 'ink'
import { ButtonTui } from '../../src/components/button/button.tui.js'

describe('ButtonTui', () => {
  it('renders default bracket label for standard buttons', () => {
    const output = renderToString(React.createElement(ButtonTui, {
      children: 'apply',
      tone: 'info',
      size: 'sm',
    }))

    expect(output).toContain('[ apply ]')
  })

  it('renders fallback label when children are not text nodes', () => {
    const output = renderToString(React.createElement(ButtonTui, {
      children: React.createElement('span', undefined, 'ignored'),
      tone: 'ghost',
      shape: 'circle',
      disabled: true,
    }))

    expect(output).toContain('(button)')
  })
})
