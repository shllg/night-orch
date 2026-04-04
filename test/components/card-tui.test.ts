import { describe, expect, it } from 'vitest'
import React from 'react'
import { Text, renderToString } from 'ink'
import { CardTui } from '../../src/components/card/card.tui.js'

describe('CardTui', () => {
  it('renders primitive children without Ink text crashes', () => {
    const output = renderToString(React.createElement(CardTui, {
      title: 'Run Summary',
      children: 'hello',
    }))

    expect(output).toContain('Run Summary')
    expect(output).toContain('hello')
  })

  it('renders array actions containing primitive values', () => {
    const output = renderToString(React.createElement(CardTui, {
      title: 'Actions',
      actions: ['a', 'b', React.createElement(Text, { key: 'c' }, 'c')],
    }))

    expect(output).toContain('a')
    expect(output).toContain('b')
    expect(output).toContain('c')
  })
})
