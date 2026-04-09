import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OperationsPanel } from '../../web/src/components/OperationsPanel.js'

describe('OperationsPanel', () => {
  it('shows deploy controls without redundant poll/sync/cleanup buttons', () => {
    const html = renderToStaticMarkup(
      React.createElement(OperationsPanel, {
        operationsEnabled: true,
        activeOperation: null,
        updateStatus: null,
        installMethod: 'git',
        onUpdate: () => {},
      }),
    )

    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

    expect(text).toContain('Operations')
    expect(text).toContain('Deploy')
    expect(text).toContain('Pull &amp; Restart')
    expect(text).not.toContain('Trigger Poll')
    expect(text).not.toContain('Run Sync')
    expect(text).not.toContain('Run Cleanup')
  })
})
